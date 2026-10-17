/**
 * auto-resume — wait for an exhausted subscription quota to reset, then continue.
 *
 * When a run ends with a usage-limit / rate-limit error (after Pi's own
 * retries), the session enters a "pending resume" state instead of just
 * stopping. The reset time is taken, in order of preference, from:
 *   0. for Codex subscriptions, the global quota endpoint used by usage.ts
 *      (exhausted window → its resetAt); also re-checked before resuming so a
 *      still-exhausted quota just reschedules instead of sending a request;
 *   1. the 429 response headers (`after_provider_response`): Codex
 *      `x-codex-{primary,secondary}-*`, Anthropic `anthropic-ratelimit-unified-reset`,
 *      `retry-after(-ms)`, OpenAI `x-ratelimit-reset-*`;
 *   2. the error text ("Try again in ~N min", "resets 3pm", ISO dates, epochs);
 *   3. a fallback backoff (5 → 15 → 30 → 60 min) when nothing is known.
 *
 * At reset time (+ a small margin), if Pi is idle and the user has not taken
 * over, a custom message triggers a new turn so the agent continues where it
 * stopped. Another quota error simply re-arms the wait.
 *
 * Pi must stay open, like Claude Code. Any prompt typed by the user cancels the
 * pending resume (a new quota error re-arms it). Escape-aborted runs never arm.
 *
 *   /autoresume            show status
 *   /autoresume now        resume immediately
 *   /autoresume cancel     drop the pending resume
 *   /autoresume on|off     enable / disable for this Pi process
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type CodexQuotaReset, isCodexSubscriptionModel, queryCodexQuotaReset } from "./usage.js";

const STATUS_KEY = "auto-resume";
const MESSAGE_TYPE = "auto-resume";
const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const TICK_MS = 15 * SECOND_MS;
const RESET_MARGIN_MS = 60 * SECOND_MS;
const BUSY_POSTPONE_MS = 30 * SECOND_MS;
const HEADER_FRESH_MS = 2 * MINUTE_MS;
const FALLBACK_DELAYS_MS = [5 * MINUTE_MS, 15 * MINUTE_MS, 30 * MINUTE_MS, 60 * MINUTE_MS];
const RESUME_PROMPT =
	"[auto-resume] The usage limit that interrupted the previous run has reset. " +
	"Continue the task exactly where you left off. Do not repeat work that is already done.";

const QUOTA_ERROR_PATTERN =
	/usage.?limit|rate.?limit|quota|too many requests|\b429\b|hit your (?:\w+ )?limit|limit (?:has been )?(?:reached|exceeded)|(?:resets?|try again) (?:at|in)\b|overloaded/i;
// Prepaid balance / billing problems never reset on their own.
const NON_RESETTING_PATTERN = /insufficient_quota|billing|available balance|credit balance|out of budget|payment/i;

type TimeoutHandle = ReturnType<typeof setInterval> & { unref?: () => void };

type Pending = {
	resumeAt: number;
	source: "usage" | "headers" | "message" | "fallback";
	attempts: number;
	error: string;
	detail: string;
};

export default function autoResumeExtension(pi: ExtensionAPI) {
	let enabled = true;
	let pending: Pending | undefined;
	let tick: TimeoutHandle | undefined;
	let lastCtx: ExtensionContext | undefined;
	let lastHeaderReset: { at: number; resetAt?: number } | undefined;
	let runError: string | undefined;
	let resuming = false;
	let attempts = 0;
	let checking = false;
	let armId = 0;

	function stopTick() {
		if (tick) clearInterval(tick);
		tick = undefined;
	}

	function clearPending(ctx: ExtensionContext | undefined, reason?: string) {
		const had = !!pending;
		pending = undefined;
		armId++;
		stopTick();
		ctx?.ui.setStatus(STATUS_KEY, undefined);
		if (had && reason) ctx?.ui.notify(reason, "info");
	}

	function renderStatus(ctx: ExtensionContext) {
		if (!pending) return;
		const theme = ctx.ui.theme;
		const label = theme.fg("warning", "⏸ quota");
		const when = `${formatClock(pending.resumeAt)} (${formatRemaining(pending.resumeAt - Date.now())})`;
		const guess = pending.source === "fallback" ? "~" : "";
		ctx.ui.setStatus(STATUS_KEY, `${label} ${theme.fg("dim", `resume ${guess}${when}`)}`);
	}

	function arm(ctx: ExtensionContext, error: string) {
		const now = Date.now();
		const headerReset = lastHeaderReset && now - lastHeaderReset.at < HEADER_FRESH_MS ? lastHeaderReset.resetAt : undefined;
		const id = ++armId;
		lastCtx = ctx;
		stopTick();
		if (!isCodexSubscriptionModel(ctx.model)) return finishArm(ctx, error, now, headerReset);
		// Codex: the quota endpoint knows which window is exhausted and when it resets; ask it first.
		ctx.ui.setStatus(STATUS_KEY, `${ctx.ui.theme.fg("warning", "⏸ quota")} ${ctx.ui.theme.fg("dim", "checking reset…")}`);
		void queryCodexQuotaReset(ctx).then((quota) => {
			if (id === armId) finishArm(ctx, error, now, headerReset, quota);
		});
	}

	function finishArm(ctx: ExtensionContext, error: string, now: number, headerReset: number | undefined, quota?: CodexQuotaReset) {
		const messageReset = parseResetFromMessage(error, now);
		let resumeAt: number;
		let source: Pending["source"];
		let detail = "";
		if (quota?.ok && quota.exhausted && quota.resetAt !== undefined) {
			resumeAt = quota.resetAt + RESET_MARGIN_MS;
			source = "usage";
			detail = ` (${quota.limits.join(", ")} exhausted)`;
		} else if (headerReset !== undefined && headerReset > now - MINUTE_MS) {
			resumeAt = headerReset + RESET_MARGIN_MS;
			source = "headers";
		} else if (messageReset !== undefined && messageReset > now - MINUTE_MS) {
			resumeAt = messageReset + RESET_MARGIN_MS;
			source = "message";
		} else {
			const delay = FALLBACK_DELAYS_MS[Math.min(attempts, FALLBACK_DELAYS_MS.length - 1)];
			resumeAt = now + delay;
			source = "fallback";
			const why = !quota ? "" : !quota.ok ? `Codex usage query failed: ${quota.error}; ` : quota.exhausted ? "Codex usage has no reset time; " : "Codex usage shows no exhausted window; ";
			detail = ` (${why}reset time unknown, checking again in ${formatRemaining(delay)})`;
		}
		// A reset already in the past means the limit is a short one; probe soon instead of looping.
		resumeAt = Math.max(resumeAt, Date.now() + 30 * SECOND_MS);
		pending = { resumeAt, source, attempts, error, detail };
		attempts++;
		renderStatus(ctx);
		ctx.ui.notify(`Usage limit reached. Pi will resume automatically at ${formatClock(resumeAt)}${detail}. /autoresume cancel to stop.`, "warning");
		stopTick();
		tick = setInterval(() => void onTick(), TICK_MS) as TimeoutHandle;
		tick.unref?.();
	}

	async function onTick() {
		const ctx = lastCtx;
		if (!pending || !ctx) return stopTick();
		if (checking) return;
		if (Date.now() < pending.resumeAt) return renderStatus(ctx);
		if (!ctx.isIdle() || ctx.hasPendingMessages()) {
			pending.resumeAt = Date.now() + BUSY_POSTPONE_MS;
			return renderStatus(ctx);
		}
		if (isCodexSubscriptionModel(ctx.model)) {
			// Avoid a request that would fail again: ask the quota endpoint first.
			const target = pending;
			checking = true;
			const quota = await queryCodexQuotaReset(ctx).finally(() => { checking = false; });
			if (pending !== target) return;
			if (quota.ok && quota.exhausted) {
				const fallback = Date.now() + FALLBACK_DELAYS_MS[0];
				target.resumeAt = quota.resetAt !== undefined && quota.resetAt > Date.now() ? quota.resetAt + RESET_MARGIN_MS : fallback;
				target.source = quota.resetAt !== undefined ? "usage" : "fallback";
				return renderStatus(ctx);
			}
		}
		resume(ctx);
	}

	function resume(ctx: ExtensionContext) {
		pending = undefined;
		stopTick();
		ctx.ui.setStatus(STATUS_KEY, undefined);
		resuming = true;
		pi.sendMessage({ customType: MESSAGE_TYPE, content: RESUME_PROMPT, display: true }, { triggerTurn: true });
	}

	pi.on("after_provider_response", (event) => {
		if (event.status !== 429) return;
		lastHeaderReset = { at: Date.now(), resetAt: parseResetFromHeaders(event.headers) };
	});

	pi.on("agent_start", () => {
		runError = undefined;
	});

	pi.on("message_end", (event) => {
		const message = event.message as { role?: string; stopReason?: string; errorMessage?: string };
		if (message.role !== "assistant") return;
		runError = message.stopReason === "error" ? message.errorMessage || "Unknown error" : undefined;
	});

	pi.on("input", (event, ctx) => {
		if (event.source === "extension") return;
		if (pending) clearPending(ctx, "Auto-resume cancelled: you took over.");
		attempts = 0;
	});

	pi.on("agent_settled", (event, ctx) => {
		const error = runError;
		const wasResuming = resuming;
		runError = undefined;
		resuming = false;
		if (event.aborted || !error) {
			if (!event.aborted && wasResuming) attempts = 0;
			return;
		}
		const recentHeaders = !!lastHeaderReset && Date.now() - lastHeaderReset.at < HEADER_FRESH_MS;
		if (!enabled || (ctx.mode !== "tui" && ctx.mode !== "rpc")) return;
		if (!isQuotaError(error) && !recentHeaders) return;
		arm(ctx, error);
	});

	pi.on("session_start", (_event, ctx) => {
		clearPending(ctx);
		attempts = 0;
	});

	pi.on("session_shutdown", (_event, ctx) => {
		clearPending(ctx);
		lastCtx = undefined;
	});

	pi.registerCommand("autoresume", {
		description: "Auto-resume after usage limits: status | now | cancel | on | off",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "on" || action === "off") {
				enabled = action === "on";
				if (!enabled) clearPending(ctx);
				ctx.ui.notify(`Auto-resume ${enabled ? "enabled" : "disabled"}.`, "info");
				return;
			}
			if (action === "cancel") {
				if (pending) clearPending(ctx, "Auto-resume cancelled.");
				else ctx.ui.notify("No pending auto-resume.", "info");
				attempts = 0;
				return;
			}
			if (action === "now") {
				if (!ctx.isIdle()) await ctx.waitForIdle();
				resume(ctx);
				return;
			}
			if (!pending) {
				ctx.ui.notify(`Auto-resume ${enabled ? "enabled" : "disabled"}; nothing pending.`, "info");
				return;
			}
			const source = pending.source === "fallback" ? "estimated (reset time unknown)" : `from ${pending.source}`;
			ctx.ui.notify(
				`Resuming at ${formatClock(pending.resumeAt)} (${formatRemaining(pending.resumeAt - Date.now())}), ${source}${pending.detail}.\nLast error: ${pending.error}`,
				"info",
			);
		},
	});
}

// ── Detection ─────────────────────────────────────────────────────────────

export function isQuotaError(message: string): boolean {
	return QUOTA_ERROR_PATTERN.test(message) && !NON_RESETTING_PATTERN.test(message);
}

/** Absolute reset time (ms epoch) announced by 429 response headers, if any. */
export function parseResetFromHeaders(raw: Record<string, string>, now = Date.now()): number | undefined {
	const headers: Record<string, string> = {};
	for (const [key, value] of Object.entries(raw)) headers[key.toLowerCase()] = String(value);

	// Codex: the window(s) at 100% decide; if both are exhausted wait for the later one.
	const codex = ["primary", "secondary"]
		.map((window) => ({
			used: num(headers[`x-codex-${window}-used-percent`]),
			after: num(headers[`x-codex-${window}-reset-after-seconds`]),
			at: num(headers[`x-codex-${window}-reset-at`]),
		}))
		.filter((window) => window.used !== undefined && window.used >= 100)
		.map((window) => (window.at !== undefined ? epochMs(window.at) : window.after !== undefined ? now + window.after * SECOND_MS : undefined))
		.filter((value): value is number => value !== undefined);
	if (codex.length) return Math.max(...codex);

	const anthropic = num(headers["anthropic-ratelimit-unified-reset"]);
	if (anthropic !== undefined) return epochMs(anthropic);

	const retryAfterMs = num(headers["retry-after-ms"]);
	if (retryAfterMs !== undefined) return now + retryAfterMs;
	const retryAfter = headers["retry-after"];
	if (retryAfter) {
		const seconds = num(retryAfter);
		if (seconds !== undefined) return now + seconds * SECOND_MS;
		const date = Date.parse(retryAfter);
		if (Number.isFinite(date)) return date;
	}

	const openai = ["x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"]
		.map((key) => (headers[key] ? parseGoDuration(headers[key]) : undefined))
		.filter((value): value is number => value !== undefined);
	if (openai.length) return now + Math.max(...openai);
	return undefined;
}

/** Absolute reset time (ms epoch) mentioned in a provider error message, if any. */
export function parseResetFromMessage(message: string, now = Date.now()): number | undefined {
	const relative = message.match(/(?:try again|retry|resets?|available again)\s+in\s+~?\s*(\d+(?:\.\d+)?)\s*(s|sec|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?)\b/i);
	if (relative) return now + Number(relative[1]) * unitMs(relative[2]);

	const iso = message.match(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/);
	if (iso) {
		const parsed = Date.parse(iso[0].replace(" ", "T"));
		if (Number.isFinite(parsed)) return parsed;
	}

	const epoch = message.match(/resets?_at["':\s=]+(\d{10,13})/i);
	if (epoch) return epochMs(Number(epoch[1]));

	const clock = message.match(/(?:resets?|try again|available)(?:\s+(?:at|after|on))?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
	if (clock && (clock[2] !== undefined || clock[3] !== undefined)) {
		let hours = Number(clock[1]);
		const minutes = Number(clock[2] ?? 0);
		const meridiem = clock[3]?.toLowerCase();
		if (meridiem === "pm" && hours < 12) hours += 12;
		if (meridiem === "am" && hours === 12) hours = 0;
		if (hours > 23 || minutes > 59) return undefined;
		const target = new Date(now);
		target.setHours(hours, minutes, 0, 0);
		if (target.getTime() <= now) target.setTime(target.getTime() + DAY_MS);
		return target.getTime();
	}
	return undefined;
}

function unitMs(unit: string): number {
	const u = unit.toLowerCase();
	if (u.startsWith("d")) return DAY_MS;
	if (u.startsWith("h")) return HOUR_MS;
	if (u.startsWith("m")) return MINUTE_MS;
	return SECOND_MS;
}

/** Parses Go-style durations such as "6m0s", "1h2m", "20ms". */
export function parseGoDuration(value: string): number | undefined {
	const parts = [...value.trim().matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)];
	if (!parts.length) return undefined;
	const factors: Record<string, number> = { h: HOUR_MS, m: MINUTE_MS, s: SECOND_MS, ms: 1 };
	return parts.reduce((total, [, amount, unit]) => total + Number(amount) * factors[unit], 0);
}

function num(value: string | undefined): number | undefined {
	if (value === undefined || value.trim() === "") return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function epochMs(value: number): number {
	return value < 10_000_000_000 ? value * SECOND_MS : value;
}

// ── Formatting ────────────────────────────────────────────────────────────

function formatClock(at: number): string {
	const date = new Date(at);
	const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
	if (date.toDateString() === new Date().toDateString()) return time;
	return `${date.toLocaleDateString([], { weekday: "short", day: "numeric" })} ${time}`;
}

export function formatRemaining(ms: number): string {
	if (ms <= 0) return "now";
	if (ms >= DAY_MS) return `${(ms / DAY_MS).toFixed(1)}d`;
	if (ms >= HOUR_MS) return `${(ms / HOUR_MS).toFixed(1)}h`;
	if (ms >= MINUTE_MS) return `${Math.ceil(ms / MINUTE_MS)}m`;
	return `${Math.ceil(ms / SECOND_MS)}s`;
}
