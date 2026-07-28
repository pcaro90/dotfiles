import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const CODEX_PROVIDER_ID = "openai-codex";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const DEFAULT_TIMEOUT_MS = 15_000;
const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const HOUR_TENTH_MS = 6 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const DAY_TENTH_MS = 144 * MINUTE_MS;
const REFRESH_INTERVAL_MS = 30 * SECOND_MS;
const REDRAW_BLINK_MS = 150;
const STATUS_KEY = "aa-codex-usage";
const MAX_ERROR_BODY_CHARS = 600;
const STATUS_LABEL_TEXT = "codex";
const USAGE_LIMIT_ID = "codex";
const DUAL_BAR_WIDTH = 10;

const DUAL_BAR_CHARS = [
	"⠀", "▘", "▝", "▀",
	"▖", "▌", "▞", "▛",
	"▗", "▚", "▐", "▜",
	"▄", "▙", "▟", "█",
];

type TimeoutHandle = ReturnType<typeof setTimeout> & { unref?: () => void };
type PiModel = NonNullable<ExtensionContext["model"]>;
type CodexUsageModel = Pick<PiModel, "id" | "name" | "provider">;

type UsageQueryError = {
	source: "pi-auth";
	message: string;
	cause?: unknown;
};

type CodexUsageReport = {
	snapshots: NormalizedRateLimitSnapshot[];
};

type NormalizedRateLimitSnapshot = {
	limitId: string;
	primary?: NormalizedRateLimitWindow;
	secondary?: NormalizedRateLimitWindow;
};

type NormalizedRateLimitWindow = {
	usedPercent: number;
	resetAt?: number;
	windowDurationMs?: number;
};

type CachedReport = {
	createdAt: number;
	report: CodexUsageReport;
};

type QueryUsageResult =
	| { ok: true; report: CodexUsageReport }
	| { ok: false; errors: UsageQueryError[] };

export default function usageExtension(pi: ExtensionAPI) {
	let cache: CachedReport | undefined;
	let failedRefreshes = 0;
	let inFlightUsageQuery: Promise<QueryUsageResult> | undefined;
	let statuslineBlinkTimer: TimeoutHandle | undefined;
	let statuslineClearTimer: TimeoutHandle | undefined;
	let statuslineCountdownTimer: TimeoutHandle | undefined;
	let statuslineRefreshTimer: TimeoutHandle | undefined;
	let statuslineRequestId = 0;

	function clearStatuslineTimers() {
		for (const timer of [statuslineBlinkTimer, statuslineClearTimer, statuslineCountdownTimer, statuslineRefreshTimer]) {
			if (timer) clearTimeout(timer);
		}
		statuslineBlinkTimer = undefined;
		statuslineClearTimer = undefined;
		statuslineCountdownTimer = undefined;
		statuslineRefreshTimer = undefined;
	}

	function clearUsageStatusline(ctx: ExtensionContext) {
		statuslineRequestId++;
		clearStatuslineTimers();
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}

	function scheduleTemporaryStatuslineClear(ctx: ExtensionContext) {
		if (statuslineClearTimer) clearTimeout(statuslineClearTimer);
		statuslineClearTimer = setTimeout(() => {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			statuslineClearTimer = undefined;
		}, REFRESH_INTERVAL_MS) as TimeoutHandle;
		statuslineClearTimer.unref?.();
	}

	function scheduleStatuslineRefresh(ctx: ExtensionContext) {
		if (statuslineRefreshTimer) clearTimeout(statuslineRefreshTimer);
		statuslineRefreshTimer = setTimeout(() => {
			statuslineRefreshTimer = undefined;
			void refreshCurrentCodexUsageStatusline(ctx, true);
		}, REFRESH_INTERVAL_MS) as TimeoutHandle;
		statuslineRefreshTimer.unref?.();
	}

	function scheduleStatuslineCountdown(ctx: ExtensionContext, report: CodexUsageReport, model?: CodexUsageModel) {
		if (statuslineCountdownTimer) clearTimeout(statuslineCountdownTimer);
		statuslineCountdownTimer = undefined;
		const delayMs = nextResetCountdownDelayMs(report, Date.now(), model);
		if (!delayMs) return;
		statuslineCountdownTimer = setTimeout(() => {
			statuslineCountdownTimer = undefined;
			if (!isOpenAICodexModel(ctx.model)) return;
			ctx.ui.setStatus(STATUS_KEY, formatCodexUsageStatusline(report, ctx, model));
			scheduleStatuslineCountdown(ctx, report, model);
		}, delayMs) as TimeoutHandle;
		statuslineCountdownTimer.unref?.();
	}

	function setUsageStatusline(ctx: ExtensionContext, report: CodexUsageReport, options: { autoRefresh: boolean; blink: boolean; model?: CodexUsageModel }) {
		for (const timer of [statuslineBlinkTimer, statuslineClearTimer, statuslineCountdownTimer]) {
			if (timer) clearTimeout(timer);
		}
		statuslineBlinkTimer = undefined;
		statuslineClearTimer = undefined;
		statuslineCountdownTimer = undefined;

		const text = formatCodexUsageStatusline(report, ctx, options.model);
		if (options.blink) {
			ctx.ui.setStatus(STATUS_KEY, formatEmptyStatuslineBar(ctx));
			statuslineBlinkTimer = setTimeout(() => {
				statuslineBlinkTimer = undefined;
				ctx.ui.setStatus(STATUS_KEY, text);
				scheduleStatuslineCountdown(ctx, report, options.model);
			}, REDRAW_BLINK_MS) as TimeoutHandle;
			statuslineBlinkTimer.unref?.();
		} else {
			ctx.ui.setStatus(STATUS_KEY, text);
			scheduleStatuslineCountdown(ctx, report, options.model);
		}

		if (options.autoRefresh) scheduleStatuslineRefresh(ctx);
		else scheduleTemporaryStatuslineClear(ctx);
	}

	async function refreshCurrentCodexUsageStatusline(ctx: ExtensionContext, force: boolean, model: ExtensionContext["model"] = ctx.model) {
		if (!isOpenAICodexModel(model)) {
			clearUsageStatusline(ctx);
			return;
		}
		if (!cache) ctx.ui.setStatus(STATUS_KEY, formatEmptyStatuslineBar(ctx));

		const requestId = ++statuslineRequestId;
		if (cache && !force && Date.now() - cache.createdAt < REFRESH_INTERVAL_MS) {
			setUsageStatusline(ctx, cache.report, { autoRefresh: true, blink: false, model });
			return;
		}

		const previousReport = cache?.report;
		const result = await queryCurrentUsage(ctx, model);
		if (requestId !== statuslineRequestId) return;
		if (!isOpenAICodexModel(ctx.model)) {
			clearUsageStatusline(ctx);
			return;
		}

		if (!result.ok) {
			failedRefreshes++;
			if (!cache || failedRefreshes >= 5) {
				for (const timer of [statuslineBlinkTimer, statuslineClearTimer, statuslineCountdownTimer]) {
					if (timer) clearTimeout(timer);
				}
				statuslineBlinkTimer = undefined;
				statuslineClearTimer = undefined;
				statuslineCountdownTimer = undefined;
				ctx.ui.setStatus(STATUS_KEY, formatStatuslineProblem(ctx, result.errors));
			}
			scheduleStatuslineRefresh(ctx);
			return;
		}

		const blink = !!previousReport && formatReportBar(previousReport) !== formatReportBar(result.report);
		failedRefreshes = 0;
		cache = { createdAt: Date.now(), report: result.report };
		setUsageStatusline(ctx, result.report, { autoRefresh: true, blink, model });
	}

	function queryCurrentUsage(ctx: ExtensionContext, model: CodexUsageModel) {
		if (!inFlightUsageQuery) {
			inFlightUsageQuery = queryUsage(ctx, { timeoutMs: DEFAULT_TIMEOUT_MS }, model)
				.finally(() => { inFlightUsageQuery = undefined; });
		}
		return inFlightUsageQuery;
	}

	pi.on("session_start", (_event, ctx) => {
		if (isOpenAICodexModel(ctx.model)) void refreshCurrentCodexUsageStatusline(ctx, false);
		else clearUsageStatusline(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		if (isOpenAICodexModel(ctx.model)) void refreshCurrentCodexUsageStatusline(ctx, false);
		else clearUsageStatusline(ctx);
	});

	pi.on("model_select", (event, ctx) => {
		if (isOpenAICodexModel(event.model)) void refreshCurrentCodexUsageStatusline(ctx, false, event.model);
		else clearUsageStatusline(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		clearUsageStatusline(ctx);
	});
}

function isOpenAICodexModel(model: ExtensionContext["model"] | undefined): model is PiModel {
	return model?.provider === CODEX_PROVIDER_ID;
}

async function queryUsage(ctx: ExtensionContext, options: { timeoutMs: number }, _model: CodexUsageModel): Promise<QueryUsageResult> {
	try {
		const report = await queryViaPiAuth(ctx, options.timeoutMs);
		const snapshot = selectUsageSnapshot(report, USAGE_LIMIT_ID);
		if (snapshot?.primary || snapshot?.secondary) return { ok: true, report };
		return { ok: false, errors: [{ source: "pi-auth", message: "pi-auth returned no displayable codex rate-limit windows" }] };
	} catch (cause) {
		return { ok: false, errors: [{ source: "pi-auth", message: errorMessage(cause), cause }] };
	}
}

async function queryViaPiAuth(ctx: ExtensionContext, timeoutMs: number): Promise<CodexUsageReport> {
	const auth = await resolvePiCodexAuth(ctx);
	if (!auth) {
		throw new Error("No Pi OpenAI Codex subscription auth was available. Use a Pi OpenAI Codex model or run /login for OpenAI ChatGPT Plus/Pro (Codex).");
	}
	const response = await fetchWithTimeout(CODEX_USAGE_URL, { headers: auth.headers }, timeoutMs);
	const text = await response.text();
	if (!response.ok) {
		throw new Error(`Codex usage endpoint returned ${response.status} ${response.statusText}: ${redactErrorBody(text)}`);
	}
	return normalizeBackendPayload(parseJsonObject(text, "Codex usage endpoint response"), Date.now(), "pi-auth");
}

async function resolvePiCodexAuth(ctx: ExtensionContext): Promise<{ headers: Record<string, string> } | undefined> {
	const seen = new Set<string>();
	const candidates: PiModel[] = [];
	const add = (model: ExtensionContext["model"] | undefined) => {
		if (!isOpenAICodexModel(model)) return;
		const key = `${model.provider}/${model.id}`;
		if (!seen.has(key)) {
			seen.add(key);
			candidates.push(model);
		}
	};

	add(ctx.model);
	for (const model of ctx.modelRegistry.getAvailable()) add(model as PiModel);
	for (const model of ctx.modelRegistry.getAll()) add(model as PiModel);

	const errors: string[] = [];
	for (const model of candidates) {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) {
			errors.push(auth.error);
			continue;
		}
		const headers = { ...(auth.headers ?? {}) };
		if (!hasHeader(headers, "authorization") && auth.apiKey) headers.Authorization = `Bearer ${auth.apiKey}`;
		if (!hasHeader(headers, "user-agent")) headers["User-Agent"] = "pi-codex-usage";
		if (hasHeader(headers, "authorization")) return { headers };
	}

	if (errors.length) throw new Error(errors.join("; "));
	return undefined;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
	return Object.keys(headers).some((key) => key.toLowerCase() === name);
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs) as TimeoutHandle;
	timer.unref?.();
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} catch (error) {
		if (timedOut) throw new Error(`Timed out after ${Math.round(timeoutMs / SECOND_MS)}s while fetching Codex usage.`);
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

export function normalizeBackendPayload(payload: unknown, capturedAt = Date.now(), _source = "pi-auth"): CodexUsageReport {
	const object = assertObject(payload, "Codex usage endpoint payload") as { rate_limit?: unknown; additional_rate_limits?: unknown };
	const snapshots: NormalizedRateLimitSnapshot[] = [];
	const main = normalizeBackendSnapshot(USAGE_LIMIT_ID, object.rate_limit, capturedAt);
	if (main) snapshots.push(main);

	if (Array.isArray(object.additional_rate_limits)) {
		for (const item of object.additional_rate_limits) {
			if (!item || typeof item !== "object" || Array.isArray(item)) continue;
			const additional = item as { limit_name?: unknown; metered_feature?: unknown; rate_limit?: unknown };
			const rawId = [asString(additional.limit_name), asString(additional.metered_feature)].filter(Boolean).join(" ");
			const snapshot = normalizeBackendSnapshot(normalizedUsageKey(rawId) ?? USAGE_LIMIT_ID, additional.rate_limit, capturedAt);
			if (snapshot) snapshots.push(snapshot);
		}
	}

	if (snapshots.length === 0) throw new Error("Codex usage endpoint returned no displayable rate-limit windows.");
	return { snapshots };
}

function normalizeBackendSnapshot(limitId: string, rateLimit: unknown, capturedAt: number): NormalizedRateLimitSnapshot | undefined {
	if (rateLimit == null) return undefined;
	if (typeof rateLimit !== "object" || Array.isArray(rateLimit)) return undefined;
	const details = rateLimit as { primary_window?: unknown; secondary_window?: unknown };
	const primary = normalizeBackendWindow(details.primary_window, capturedAt);
	const secondary = normalizeBackendWindow(details.secondary_window, capturedAt);
	if (!primary && !secondary) return undefined;
	return { limitId, primary, secondary };
}

function normalizeBackendWindow(value: unknown, capturedAt: number): NormalizedRateLimitWindow | undefined {
	if (value == null) return undefined;
	if (typeof value !== "object" || Array.isArray(value)) return undefined;
	const window = value as {
		used_percent?: unknown;
		reset_at?: unknown;
		resets_at?: unknown;
		reset_time?: unknown;
		end_time?: unknown;
		ends_at?: unknown;
		expires_at?: unknown;
		reset_after_seconds?: unknown;
		limit_window_seconds?: unknown;
		window_seconds?: unknown;
		window_minutes?: unknown;
	};
	const usedPercent = asNumber(window.used_percent);
	if (usedPercent === undefined) return undefined;
	const resetAt = asResetTime([
		window.reset_at,
		window.resets_at,
		window.reset_time,
		window.end_time,
		window.ends_at,
		window.expires_at,
	], window.reset_after_seconds, capturedAt);
	const windowDurationMs = asDurationMs(window.limit_window_seconds, window.window_seconds, window.window_minutes);
	return {
		usedPercent,
		...(resetAt === undefined ? {} : { resetAt }),
		...(windowDurationMs === undefined ? {} : { windowDurationMs }),
	};
}

function normalizedUsageKey(value: unknown): string | undefined {
	const normalized = String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
	return normalized || undefined;
}

function selectUsageSnapshot(report: CodexUsageReport, limitId: string): NormalizedRateLimitSnapshot | undefined {
	const key = normalizedUsageKey(limitId);
	return report.snapshots.find((snapshot) => normalizedUsageKey(snapshot.limitId) === key);
}

export function formatCodexUsageStatusValue(report: CodexUsageReport, modelOrNow?: CodexUsageModel | number, now = Date.now()): string | undefined {
	const snapshot = selectUsageSnapshot(report, USAGE_LIMIT_ID);
	if (!snapshot?.primary && !snapshot?.secondary) return undefined;
	const effectiveNow = typeof modelOrNow === "number" ? modelOrNow : now;
	const bar = formatSnapshotBar(snapshot);

	if (snapshot.primary && isWindowExhausted(snapshot.primary) && snapshot.primary.resetAt !== undefined) {
		const primaryCountdown = formatResetCountdown(snapshot.primary.resetAt, effectiveNow);
		const secondaryCountdown = snapshot.secondary?.resetAt === undefined ? undefined : formatResetCountdown(snapshot.secondary.resetAt, effectiveNow);
		return secondaryCountdown ? `${bar} ${primaryCountdown}/${secondaryCountdown}` : `${bar} ${primaryCountdown}`;
	}

	const longWindow = selectLongWindow(snapshot);
	if (!isWindowExhausted(snapshot.primary) && longWindow?.resetAt !== undefined) {
		return `${bar} ${formatResetCountdown(longWindow.resetAt, effectiveNow)}`;
	}
	return bar;
}

export function formatWeeklyResetCountdown(report: CodexUsageReport, modelOrNow?: CodexUsageModel | number, now = Date.now()): string | undefined {
	const snapshot = selectUsageSnapshot(report, USAGE_LIMIT_ID);
	const effectiveNow = typeof modelOrNow === "number" ? modelOrNow : now;
	const longWindow = snapshot ? selectLongWindow(snapshot) : undefined;
	return longWindow?.resetAt === undefined ? undefined : formatResetCountdown(longWindow.resetAt, effectiveNow);
}

export function formatCodexUsageBar(report: CodexUsageReport): string | undefined {
	return formatReportBar(report);
}

function formatReportBar(report: CodexUsageReport): string | undefined {
	const snapshot = selectUsageSnapshot(report, USAGE_LIMIT_ID);
	if (!snapshot?.primary && !snapshot?.secondary) return undefined;
	return formatSnapshotBar(snapshot);
}

function formatSnapshotBar(snapshot: NormalizedRateLimitSnapshot): string {
	// OpenAI can return a single window (currently a weekly primary window).
	// Mirror it into both halves so a valid limit does not look like a half-empty bar.
	const primary = snapshot.primary ?? snapshot.secondary;
	const secondary = snapshot.secondary ?? snapshot.primary;
	return formatDualLimitBar(primary, secondary);
}

function selectLongWindow(snapshot: NormalizedRateLimitSnapshot): NormalizedRateLimitWindow | undefined {
	const { primary, secondary } = snapshot;
	if (!primary) return secondary;
	if (!secondary) return primary;
	if (primary.windowDurationMs !== undefined && secondary.windowDurationMs !== undefined) {
		return primary.windowDurationMs > secondary.windowDurationMs ? primary : secondary;
	}
	// Preserve the historical API convention when duration metadata is absent.
	return secondary;
}

function formatDualLimitBar(primary?: NormalizedRateLimitWindow, secondary?: NormalizedRateLimitWindow): string {
	const primaryParts = filledParts(primary, DUAL_BAR_WIDTH * 2);
	const secondaryParts = filledParts(secondary, DUAL_BAR_WIDTH * 2);
	let bar = "";
	for (let index = 0; index < DUAL_BAR_WIDTH; index++) {
		const leftPart = index * 2 + 1;
		const rightPart = leftPart + 1;
		let mask = 0;
		if (primaryParts >= leftPart) mask |= 1;
		if (primaryParts >= rightPart) mask |= 2;
		if (secondaryParts >= leftPart) mask |= 4;
		if (secondaryParts >= rightPart) mask |= 8;
		bar += DUAL_BAR_CHARS[mask];
	}
	return bar;
}

function filledParts(window: NormalizedRateLimitWindow | undefined, totalParts: number): number {
	if (!window) return 0;
	const remaining = remainingPercent(window);
	if (remaining <= 0) return 0;
	return Math.max(1, Math.round(remaining / (100 / totalParts)));
}

function remainingPercent(window: NormalizedRateLimitWindow): number {
	return 100 - clampPercent(window.usedPercent);
}

function clampPercent(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(100, Math.max(0, value));
}

function isWindowExhausted(window: NormalizedRateLimitWindow | undefined): boolean {
	return !!window && remainingPercent(window) <= 0;
}

export function formatCodexUsageStatusline(report: CodexUsageReport, ctx: ExtensionContext, model?: CodexUsageModel): string {
	const value = formatCodexUsageStatusValue(report, model);
	if (!value) return formatStatuslineText(ctx, "n/a", model);
	const separator = value.indexOf(" ");
	const bar = separator === -1 ? value : value.slice(0, separator);
	const countdown = separator === -1 ? undefined : value.slice(separator + 1);
	const snapshot = selectUsageSnapshot(report, USAGE_LIMIT_ID);
	const background = isWindowExhausted(snapshot?.primary) || isWindowExhausted(snapshot?.secondary) ? "toolErrorBg" : "selectedBg";
	const barText = formatStatuslineBarText(ctx, bar, background, model);
	return countdown ? `${barText} ${ctx.ui.theme.fg("dim", countdown)}` : barText;
}

function formatStatuslineText(ctx: ExtensionContext, value: string, _model?: CodexUsageModel): string {
	return `${ctx.ui.theme.fg("accent", STATUS_LABEL_TEXT)} ${ctx.ui.theme.fg("dim", value)}`;
}

function formatStatuslineBarText(ctx: ExtensionContext, bar: string, background: "selectedBg" | "toolErrorBg" = "selectedBg", _model?: CodexUsageModel): string {
	const label = ctx.ui.theme.fg("accent", STATUS_LABEL_TEXT);
	const value = ctx.ui.theme.bg(background, ctx.ui.theme.fg("dim", bar));
	return `${label} ${value}`;
}

function formatEmptyStatuslineBar(ctx: ExtensionContext): string {
	return formatStatuslineBarText(ctx, "⠀".repeat(DUAL_BAR_WIDTH));
}

function formatStatuslineProblem(ctx: ExtensionContext, errors: UsageQueryError[]): string {
	const label = ctx.ui.theme.fg("accent", STATUS_LABEL_TEXT);
	const value = isUsageUnavailable(errors)
		? ctx.ui.theme.fg("muted", "n/a")
		: ctx.ui.theme.fg("error", "error");
	return `${label} ${value}`;
}

export function formatResetCountdown(resetAt: number, now = Date.now()): string {
	const remainingMs = Math.max(0, resetAt - now);
	if (remainingMs > DAY_MS) {
		return `${formatTenths(Math.max(10, Math.ceil(remainingMs / DAY_TENTH_MS)))}d`;
	}
	if (remainingMs >= HOUR_MS) {
		return `${formatTenths(Math.max(10, Math.ceil(remainingMs / HOUR_TENTH_MS)))}h`;
	}
	if (remainingMs >= MINUTE_MS) return `${Math.floor(remainingMs / MINUTE_MS)}m`;
	return `${Math.floor(remainingMs / SECOND_MS)}s`;
}

function formatTenths(value: number): string {
	return value % 10 === 0 ? String(value / 10) : (value / 10).toFixed(1);
}

export function nextResetCountdownDelayMs(report: CodexUsageReport, now = Date.now(), _model?: CodexUsageModel): number | undefined {
	const snapshot = selectUsageSnapshot(report, USAGE_LIMIT_ID);
	if (!snapshot) return undefined;
	const longWindow = selectLongWindow(snapshot);
	const resetTimes = [longWindow?.resetAt];
	if (isWindowExhausted(snapshot.primary) && snapshot.primary !== longWindow) resetTimes.push(snapshot.primary?.resetAt);
	const delays = resetTimes
		.map((resetAt) => resetAt === undefined ? undefined : nextResetCountdownDelayForRemainingMs(resetAt - now))
		.filter((delay): delay is number => delay !== undefined);
	return delays.length ? Math.min(...delays) : undefined;
}

export function nextResetCountdownDelayForRemainingMs(remainingMs: number): number | undefined {
	if (remainingMs <= 0) return undefined;
	if (remainingMs > DAY_MS) {
		const dayTenths = Math.max(10, Math.ceil(remainingMs / DAY_TENTH_MS));
		return Math.max(1, remainingMs - (dayTenths - 1) * DAY_TENTH_MS);
	}
	if (remainingMs >= HOUR_MS) {
		const hourTenths = Math.max(10, Math.ceil(remainingMs / HOUR_TENTH_MS));
		if (hourTenths === 10) return Math.max(1, remainingMs - HOUR_MS + 1);
		return Math.max(1, remainingMs - (hourTenths - 1) * HOUR_TENTH_MS);
	}
	if (remainingMs >= MINUTE_MS) return Math.max(1, remainingMs - Math.floor(remainingMs / MINUTE_MS) * MINUTE_MS + 1);
	return Math.max(1, remainingMs - Math.floor(remainingMs / SECOND_MS) * SECOND_MS + 1);
}

export function isUsageUnavailable(errors: UsageQueryError[]): boolean {
	return errors.length > 0 && errors.every(isUnavailableError);
}

function isUnavailableError(error: UsageQueryError): boolean {
	const message = error.message.toLowerCase();
	return [
		"no pi openai codex subscription auth",
		"no displayable rate-limit windows",
		"returned no displayable rate-limit windows",
		"returned 401",
		"returned 403",
		"unauthorized",
		"forbidden",
		"subscription",
		"no active plan",
		"plan unavailable",
		"quota unavailable",
		"rate limits unavailable",
	].some((text) => message.includes(text));
}

function parseJsonObject(text: string, description: string): Record<string, unknown> {
	try {
		return assertObject(JSON.parse(text), description) as Record<string, unknown>;
	} catch (error) {
		if (error instanceof SyntaxError) throw new Error(`${description} was not valid JSON: ${error.message}`);
		throw error;
	}
}

function assertObject(value: unknown, description: string): object {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${description} was not an object.`);
	return value;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function asResetTime(absoluteValues: unknown[], relativeSeconds: unknown, capturedAt: number): number | undefined {
	for (const value of absoluteValues) {
		const timestamp = asTimestampMs(value);
		if (timestamp !== undefined) return timestamp;
	}
	const seconds = asNumber(relativeSeconds);
	return seconds === undefined || seconds < 0 ? undefined : capturedAt + seconds * SECOND_MS;
}

function asDurationMs(secondsValue: unknown, fallbackSecondsValue: unknown, minutesValue: unknown): number | undefined {
	const seconds = asNumber(secondsValue) ?? asNumber(fallbackSecondsValue);
	const minutes = asNumber(minutesValue);
	const durationMs = seconds !== undefined ? seconds * SECOND_MS : minutes === undefined ? undefined : minutes * MINUTE_MS;
	return durationMs === undefined || durationMs < 0 || !Number.isFinite(durationMs) ? undefined : durationMs;
}

function asTimestampMs(value: unknown): number | undefined {
	if (typeof value === "number") return timestampNumberMs(value);
	if (typeof value === "string" && value.trim() !== "") {
		const numeric = Number(value);
		if (Number.isFinite(numeric)) return timestampNumberMs(numeric);
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function timestampNumberMs(value: number): number | undefined {
	if (!Number.isFinite(value) || value <= 0) return undefined;
	return value < 10_000_000_000 ? value * SECOND_MS : value;
}

function redactErrorBody(body: string): string {
	return truncateEnd(
		body
			.replace(/Bearer\s+[^\s"']+/gi, "Bearer <redacted>")
			.replace(/"access_token"\s*:\s*"[^"]*"/gi, '"access_token":"<redacted>"')
			.trim(),
		MAX_ERROR_BODY_CHARS,
	);
}

function truncateEnd(value: string, maxChars: number): string {
	return value.length <= maxChars ? value : value.slice(0, maxChars - 1) + "…";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
