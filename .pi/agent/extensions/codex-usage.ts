/**
 * codex-usage — Codex subscription quota in the footer, and auto-resume after usage limits.
 *
 * Footer: with an `openai`/`openai-codex` OAuth model, shows the plan windows (5h and weekly)
 * as a dual bar plus reset countdowns. The quota is read from chatgpt.com with the legacy
 * `openai-codex` login (the new OpenAI OAuth token cannot read it), after every run and every
 * 5 minutes while idle.
 *
 * Auto-resume: when a run ends on a usage/rate limit, waits for the reset and sends a message
 * that continues the task. The reset time comes from, in order: the most used Codex window when
 * it is (nearly) full, the 429 headers, the error text, or a 5 → 15 → 30 → 60 min backoff.
 * Any prompt typed by the user cancels it; escape-aborted runs never arm. Pi must stay open.
 *
 *   /autoresume [now|cancel|on|off]
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Window = { usedPercent: number; resetAt?: number; durationMs?: number };
type Report = { primary?: Window; secondary?: Window };
type Pending = { resumeAt: number; guess: boolean; error: string; detail: string };

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const FOOTER_KEY = "aa-codex-usage";
const RESUME_KEY = "auto-resume";
const SECOND = 1_000, MINUTE = 60 * SECOND, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const TICK_MS = 30 * SECOND;
const FRESH_MS = 30 * SECOND;
const IDLE_REFRESH_MS = 5 * MINUTE;
const FULL_PERCENT = 90;
const RESET_MARGIN_MS = MINUTE;
const HEADER_FRESH_MS = 2 * MINUTE;
const BACKOFF_MS = [5, 15, 30, 60].map((minutes) => minutes * MINUTE);
const BAR_WIDTH = 10;
// Bits: 1/2 = left/right half of the top window, 4/8 = left/right half of the bottom one.
const BAR_CHARS = "⠀▘▝▀▖▌▞▛▗▚▐▜▄▙▟█";
const RESUME_PROMPT =
	"[auto-resume] The usage limit that interrupted the previous run has reset. " +
	"Continue the task exactly where you left off. Do not repeat work that is already done.";

const QUOTA_ERROR =
	/usage.?limit|rate.?limit|quota|too many requests|\b429\b|hit your (?:\w+ )?limit|limit (?:has been )?(?:reached|exceeded)|(?:resets?|try again) (?:at|in)\b|overloaded/i;
// Prepaid balance / billing problems never reset on their own.
const NON_RESETTING = /insufficient_quota|billing|available balance|credit balance|out of budget|payment/i;
const LOGIN_REQUIRED = /no pi legacy openai codex subscription auth|refresh_token_(?:expired|reused)|invalid_refresh_token|invalid_grant|please log in again/i;
const UNAVAILABLE = /no plan windows|returned 40[13]|unauthorized|forbidden|subscription|no active plan|(?:plan|quota|rate limits) unavailable/i;

export default function codexUsage(pi: ExtensionAPI) {
	let session = 0;
	let ticker: ReturnType<typeof setInterval> | undefined;
	let cache: { at: number; report: Report } | undefined;
	let inFlight: Promise<Report> | undefined;
	let failures = 0;

	let enabled = true;
	let pending: Pending | undefined;
	let armId = 0;
	let attempts = 0;
	let resuming = false;
	let runError: string | undefined;
	let headerReset: { at: number; resetAt?: number } | undefined;

	const isCodex = (model: ExtensionContext["model"]) => model?.provider === "openai" || model?.provider === "openai-codex";
	const subscribed = (ctx: ExtensionContext, model = ctx.model) => isCodex(model) && ctx.modelRegistry.isUsingOAuth(model!);

	function fetchReport(ctx: ExtensionContext): Promise<Report> {
		inFlight ??= queryReport(ctx)
			.then((report) => (cache = { at: Date.now(), report }).report)
			.finally(() => { inFlight = undefined; });
		return inFlight;
	}

	async function refreshFooter(ctx: ExtensionContext, maxAge: number, model = ctx.model) {
		if (!subscribed(ctx, model)) return ctx.ui.setStatus(FOOTER_KEY, undefined);
		if (cache && Date.now() - cache.at < maxAge) return ctx.ui.setStatus(FOOTER_KEY, footer(ctx, cache.report));
		if (!cache) ctx.ui.setStatus(FOOTER_KEY, footer(ctx));
		const id = session;
		let error: string | undefined;
		try {
			await fetchReport(ctx);
			failures = 0;
		} catch (cause) {
			failures++;
			error = errorMessage(cause);
		}
		if (id !== session || !subscribed(ctx)) return;
		// Transient failures keep the last valid value.
		ctx.ui.setStatus(FOOTER_KEY, error && (!cache || failures >= 5) ? problem(ctx, error) : footer(ctx, cache?.report));
	}

	function setResumeStatus(ctx: ExtensionContext, text: string) {
		ctx.ui.setStatus(RESUME_KEY, `${ctx.ui.theme.fg("warning", "⏸ quota")} ${ctx.ui.theme.fg("dim", text)}`);
	}

	function cancel(ctx: ExtensionContext, reason?: string) {
		armId++;
		if (pending && reason) ctx.ui.notify(reason, "info");
		pending = undefined;
		ctx.ui.setStatus(RESUME_KEY, undefined);
	}

	function resume(ctx: ExtensionContext) {
		cancel(ctx);
		resuming = true;
		pi.sendMessage({ customType: "auto-resume", content: RESUME_PROMPT, display: true }, { triggerTurn: true });
	}

	async function arm(ctx: ExtensionContext, error: string) {
		const id = ++armId;
		const now = Date.now();
		const fromHeaders = headerReset && now - headerReset.at < HEADER_FRESH_MS ? headerReset.resetAt : undefined;
		let quota: ReturnType<typeof blockingWindow> | string | undefined;
		if (isCodex(ctx.model)) {
			setResumeStatus(ctx, "checking reset…");
			try { quota = blockingWindow(await fetchReport(ctx)); } catch (cause) { quota = errorMessage(cause); }
			if (id !== armId) return;
		}
		// Only a (nearly) full window explains the block. Right after a reset the API can keep refusing
		// for a while with the windows near 0%; waiting for the other window would be wrong.
		const usage = typeof quota === "object" && quota.usedPercent >= FULL_PERCENT && (quota.resetAt ?? 0) > now ? quota : undefined;
		const known = usage?.resetAt ?? [fromHeaders, parseResetFromMessage(error, now)].find((at) => at !== undefined && at > now - MINUTE);
		let resumeAt: number;
		let detail = "";
		if (known !== undefined) {
			resumeAt = known + RESET_MARGIN_MS;
			if (usage) detail = ` (${usage.label} window at ${Math.round(usage.usedPercent)}%)`;
		} else {
			const delay = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)];
			resumeAt = now + delay;
			const why = typeof quota === "string" ? `Codex usage query failed: ${quota}; `
				: quota ? `most used Codex window is ${quota.label} at ${Math.round(quota.usedPercent)}%; ` : "";
			detail = ` (${why}reset time unknown, checking again in ${formatCountdown(delay)})`;
		}
		// A reset already in the past means the limit is a short one; probe soon instead of looping.
		resumeAt = Math.max(resumeAt, Date.now() + 30 * SECOND);
		pending = { resumeAt, guess: known === undefined, error, detail };
		attempts++;
		setResumeStatus(ctx, `resume ${pending.guess ? "~" : ""}${formatClock(resumeAt)}`);
		ctx.ui.notify(`Usage limit reached. Pi will resume automatically at ${formatClock(resumeAt)}${detail}. /autoresume cancel to stop.`, "warning");
	}

	// One wall-clock tick for both features, so a suspended laptop resumes on time.
	function tick(ctx: ExtensionContext) {
		if (subscribed(ctx)) void refreshFooter(ctx, IDLE_REFRESH_MS);
		if (pending && Date.now() >= pending.resumeAt && ctx.isIdle() && !ctx.hasPendingMessages()) resume(ctx);
	}

	pi.on("session_start", (_event, ctx) => {
		session++;
		cancel(ctx);
		attempts = 0;
		if (ticker) clearInterval(ticker);
		ticker = setInterval(() => tick(ctx), TICK_MS);
		ticker.unref?.();
		void refreshFooter(ctx, FRESH_MS);
	});
	pi.on("session_tree", (_event, ctx) => void refreshFooter(ctx, FRESH_MS));
	pi.on("model_select", (event, ctx) => void refreshFooter(ctx, FRESH_MS, event.model));
	pi.on("session_shutdown", (_event, ctx) => {
		session++;
		if (ticker) clearInterval(ticker);
		ticker = undefined;
		cancel(ctx);
		ctx.ui.setStatus(FOOTER_KEY, undefined);
	});

	pi.on("after_provider_response", (event) => {
		if (event.status === 429) headerReset = { at: Date.now(), resetAt: parseResetFromHeaders(event.headers) };
	});
	pi.on("agent_start", () => { runError = undefined; });
	pi.on("message_end", (event) => {
		const message = event.message as { role?: string; stopReason?: string; errorMessage?: string };
		if (message.role === "assistant") runError = message.stopReason === "error" ? message.errorMessage || "Unknown error" : undefined;
	});
	pi.on("input", (event, ctx) => {
		if (event.source === "extension") return;
		cancel(ctx, "Auto-resume cancelled: you took over.");
		attempts = 0;
	});
	pi.on("agent_settled", (event, ctx) => {
		const error = runError, wasResuming = resuming;
		runError = undefined;
		resuming = false;
		const recentHeaders = !!headerReset && Date.now() - headerReset.at < HEADER_FRESH_MS;
		if (!event.aborted && !error && wasResuming) attempts = 0;
		if (!event.aborted && error && enabled && (ctx.mode === "tui" || ctx.mode === "rpc") && (isQuotaError(error) || recentHeaders)) void arm(ctx, error);
		void refreshFooter(ctx, FRESH_MS);
	});

	pi.registerCommand("autoresume", {
		description: "Auto-resume after usage limits: status | now | cancel | on | off",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "on" || action === "off") {
				enabled = action === "on";
				if (!enabled) cancel(ctx);
				return ctx.ui.notify(`Auto-resume ${enabled ? "enabled" : "disabled"}.`, "info");
			}
			if (action === "cancel") {
				attempts = 0;
				return pending ? cancel(ctx, "Auto-resume cancelled.") : ctx.ui.notify("No pending auto-resume.", "info");
			}
			if (action === "now") {
				await ctx.waitForIdle();
				return resume(ctx);
			}
			ctx.ui.notify(pending
				? `Resuming at ${formatClock(pending.resumeAt)}${pending.guess ? " (estimated)" : ""}${pending.detail}.\nLast error: ${pending.error}`
				: `Auto-resume ${enabled ? "enabled" : "disabled"}; nothing pending.`, "info");
		},
	});
}

// ── Codex quota ───────────────────────────────────────────────────────────

async function queryReport(ctx: ExtensionContext): Promise<Report> {
	const response = await fetch(USAGE_URL, { headers: await legacyAuthHeaders(ctx), signal: AbortSignal.timeout(15 * SECOND) });
	const text = await response.text();
	if (!response.ok) throw new Error(`Codex usage endpoint returned ${response.status} ${response.statusText}: ${redact(text)}`);
	return parseReport(JSON.parse(text));
}

/** Sign in with ChatGPT (`openai`) tokens target api.openai.com; only the legacy OAuth reads this endpoint. */
async function legacyAuthHeaders(ctx: ExtensionContext): Promise<Record<string, string>> {
	const model = [ctx.model, ...ctx.modelRegistry.getAll()].find((m) => m?.provider === "openai-codex" && ctx.modelRegistry.isUsingOAuth(m));
	const auth = model && await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (auth && !auth.ok) throw new Error(auth.error);
	const headers = Object.fromEntries(Object.entries(auth?.headers ?? {}).filter((entry): entry is [string, string] => entry[1] != null));
	const has = (name: string) => Object.keys(headers).some((key) => key.toLowerCase() === name);
	if (!has("authorization") && auth?.apiKey) headers.Authorization = `Bearer ${auth.apiKey}`;
	if (!has("user-agent")) headers["User-Agent"] = "pi-codex-usage";
	if (!has("authorization")) {
		throw new Error("No Pi legacy OpenAI Codex subscription auth was available to read the global quota. Run /login for OpenAI Codex (legacy), or check https://chatgpt.com/settings/usage.");
	}
	return headers;
}

export function parseReport(payload: any, now = Date.now()): Report {
	const window = (value: any): Window | undefined => {
		const usedPercent = num(value?.used_percent);
		if (usedPercent === undefined) return undefined;
		const at = num(value.reset_at), after = num(value.reset_after_seconds), seconds = num(value.limit_window_seconds);
		return {
			usedPercent,
			resetAt: at ? epochMs(at) : after !== undefined ? now + after * SECOND : undefined,
			durationMs: seconds && seconds * SECOND,
		};
	};
	const report = { primary: window(payload?.rate_limit?.primary_window), secondary: window(payload?.rate_limit?.secondary_window) };
	if (!report.primary && !report.secondary) throw new Error("Codex usage returned no plan windows.");
	return report;
}

/** The most used window is the one blocking requests; on a tie, the later reset unblocks them. */
export function blockingWindow(report: Report) {
	const [name, window] = (Object.entries(report) as [string, Window | undefined][])
		.filter((entry): entry is [string, Window] => !!entry[1])
		.sort(([, a], [, b]) => percent(b.usedPercent) - percent(a.usedPercent) || (b.resetAt ?? 0) - (a.resetAt ?? 0))[0];
	const ms = window.durationMs;
	const label = !ms ? name : ms >= DAY ? `${Math.round(ms / DAY)}d` : `${Math.round(ms / HOUR)}h`;
	return { label, usedPercent: percent(window.usedPercent), resetAt: window.resetAt };
}

// ── Footer ────────────────────────────────────────────────────────────────

function footer(ctx: ExtensionContext, report?: Report): string {
	const { theme } = ctx.ui;
	const label = theme.fg("accent", "openai");
	if (!report) return `${label} ${theme.bg("selectedBg", theme.fg("dim", BAR_CHARS[0].repeat(BAR_WIDTH)))}`;
	const windows = [report.primary, report.secondary].filter((window): window is Window => !!window);
	const exhausted = windows.some((window) => percent(window.usedPercent) >= 100);
	// A single window (currently a weekly primary) fills both rows instead of looking half empty.
	const bar = dualBar(windows[0], windows.at(-1)!);
	const now = Date.now();
	const countdowns = windows.filter((window) => window.resetAt !== undefined).map((window) => formatCountdown(window.resetAt! - now)).join("/");
	return `${label} ${theme.bg(exhausted ? "toolErrorBg" : "selectedBg", theme.fg("dim", bar))}${countdowns ? ` ${theme.fg("dim", countdowns)}` : ""}`;
}

function dualBar(top: Window, bottom: Window): string {
	const parts = (window: Window) => {
		const remaining = 100 - percent(window.usedPercent);
		return remaining <= 0 ? 0 : Math.max(1, Math.round(remaining / (50 / BAR_WIDTH)));
	};
	const a = parts(top), b = parts(bottom);
	let bar = "";
	for (let i = 0; i < BAR_WIDTH; i++) {
		const left = 2 * i + 1, right = left + 1;
		bar += BAR_CHARS[(a >= left ? 1 : 0) | (a >= right ? 2 : 0) | (b >= left ? 4 : 0) | (b >= right ? 8 : 0)];
	}
	return bar;
}

function problem(ctx: ExtensionContext, error: string): string {
	const { theme } = ctx.ui;
	const value = LOGIN_REQUIRED.test(error) ? theme.fg("muted", "login legacy")
		: UNAVAILABLE.test(error) ? theme.fg("muted", "n/a") : theme.fg("error", "error");
	return `${theme.fg("accent", "openai")} ${value}`;
}

// ── Reset detection ───────────────────────────────────────────────────────

export function isQuotaError(message: string): boolean {
	return QUOTA_ERROR.test(message) && !NON_RESETTING.test(message);
}

/** Absolute reset time (ms epoch) announced by 429 response headers, if any. */
export function parseResetFromHeaders(raw: Record<string, string>, now = Date.now()): number | undefined {
	const headers = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key.toLowerCase(), String(value)]));

	// Codex: the window(s) at 100% decide; if both are exhausted wait for the later one.
	const codex = ["primary", "secondary"]
		.filter((window) => (num(headers[`x-codex-${window}-used-percent`]) ?? 0) >= 100)
		.map((window) => {
			const at = num(headers[`x-codex-${window}-reset-at`]), after = num(headers[`x-codex-${window}-reset-after-seconds`]);
			return at !== undefined ? epochMs(at) : after !== undefined ? now + after * SECOND : undefined;
		})
		.filter((at): at is number => at !== undefined);
	if (codex.length) return Math.max(...codex);

	const anthropic = num(headers["anthropic-ratelimit-unified-reset"]);
	if (anthropic !== undefined) return epochMs(anthropic);
	const retryAfterMs = num(headers["retry-after-ms"]);
	if (retryAfterMs !== undefined) return now + retryAfterMs;
	const retryAfter = headers["retry-after"];
	if (retryAfter) {
		const seconds = num(retryAfter), date = Date.parse(retryAfter);
		if (seconds !== undefined) return now + seconds * SECOND;
		if (Number.isFinite(date)) return date;
	}

	// OpenAI: Go-style durations such as "6m0s", "1h2m", "20ms".
	const factors: Record<string, number> = { h: HOUR, m: MINUTE, s: SECOND, ms: 1 };
	const openai = ["x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"]
		.map((key) => [...(headers[key] ?? "").matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)])
		.filter((parts) => parts.length)
		.map((parts) => parts.reduce((total, [, amount, unit]) => total + Number(amount) * factors[unit], 0));
	return openai.length ? now + Math.max(...openai) : undefined;
}

/** Absolute reset time (ms epoch) mentioned in a provider error message, if any. */
export function parseResetFromMessage(message: string, now = Date.now()): number | undefined {
	const relative = message.match(/(?:try again|retry|resets?|available again)\s+in\s+~?\s*(\d+(?:\.\d+)?)\s*(s|sec|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?)\b/i);
	if (relative) return now + Number(relative[1]) * ({ d: DAY, h: HOUR, m: MINUTE }[relative[2][0].toLowerCase()] ?? SECOND);

	const iso = Date.parse(message.match(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/)?.[0].replace(" ", "T") ?? "");
	if (Number.isFinite(iso)) return iso;

	const epoch = message.match(/resets?_at["':\s=]+(\d{10,13})/i);
	if (epoch) return epochMs(Number(epoch[1]));

	const clock = message.match(/(?:resets?|try again|available)(?:\s+(?:at|after|on))?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
	if (!clock || (clock[2] === undefined && clock[3] === undefined)) return undefined;
	const meridiem = clock[3]?.toLowerCase();
	const hours = (Number(clock[1]) % (meridiem ? 12 : 24)) + (meridiem === "pm" ? 12 : 0);
	const minutes = Number(clock[2] ?? 0);
	if (Number(clock[1]) > 23 || minutes > 59) return undefined;
	const target = new Date(now);
	target.setHours(hours, minutes, 0, 0);
	return target.getTime() > now ? target.getTime() : target.getTime() + DAY;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function num(value: unknown): number | undefined {
	const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
	return Number.isFinite(parsed) ? parsed : undefined;
}

const epochMs = (value: number) => (value < 10_000_000_000 ? value * SECOND : value);
const percent = (value: number) => (Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0);
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
const redact = (body: string) =>
	body.replace(/Bearer\s+[^\s"']+/gi, "Bearer <redacted>").replace(/"access_token"\s*:\s*"[^"]*"/gi, '"access_token":"<redacted>"').trim().slice(0, 600);

export function formatCountdown(ms: number): string {
	const tenths = (value: number) => {
		const t = Math.max(10, Math.ceil(value * 10));
		return t % 10 ? (t / 10).toFixed(1) : String(t / 10);
	};
	if (ms > DAY) return `${tenths(ms / DAY)}d`;
	if (ms >= HOUR) return `${tenths(ms / HOUR)}h`;
	if (ms >= MINUTE) return `${Math.floor(ms / MINUTE)}m`;
	return `${Math.max(0, Math.floor(ms / SECOND))}s`;
}

function formatClock(at: number): string {
	const date = new Date(at);
	const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
	if (date.toDateString() === new Date().toDateString()) return time;
	return `${date.toLocaleDateString([], { weekday: "short", day: "numeric" })} ${time}`;
}
