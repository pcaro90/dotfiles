/**
 * footer — replaces Pi's three-line footer with one dense line.
 *
 *   [session] · path · branch · usage-ext · $cost [CHnn%] ctx%/window ↻      [statuses] · model · thinking
 *
 * Healthy values stay quiet: the cache hit rate only appears when it drops, the context only
 * changes color as it nears the auto-compaction threshold, and the cost hides on subscriptions.
 * The auto-compaction glyph is always shown: ↻ on, ⊘ off. Pi does not expose that flag to
 * extensions, so it is read from the global and project settings.json files and re-read when
 * they change (toggling it in /settings rewrites the global file).
 *
 * When the line does not fit, segments shrink in a fixed order (see SHRINK_STEPS).
 *
 *   /footer   toggle between this footer and Pi's built-in one
 */
import { readFileSync, watch, type FSWatcher } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Status keys shown on the left, next to the usage info, instead of with the other statuses. */
const USAGE_STATUS_KEYS = ["aa-codex-usage"];
const DEFAULT_RESERVE_TOKENS = 16_384;
/** Context share of the compaction threshold from which the context turns to warning. */
const CONTEXT_WARN = 0.8;
/** Cache hit rates below these show up (warning) or turn to error. */
const CACHE_WARN = 80;
const CACHE_BAD = 50;
/** Assistant replies after a compaction before the cache hit rate is judged (the first is cold). */
const CACHE_WARMUP = 2;
const MIN_GAP = 2;
/** Blank columns at both ends of the line. */
const PADDING = 1;

type Theme = ExtensionContext["ui"]["theme"];
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: { total: number } };
type CompactionSettings = { enabled?: boolean; reserveTokens?: number; modelOverrides?: Record<string, { reserveTokens?: number }> };

export type SegmentId = "name" | "path" | "branch" | "usage" | "stats" | "statuses" | "model" | "thinking";
/** variants[0] is the full form; later ones are more compact; "" drops the segment. */
export type Segment = { id: SegmentId; variants: string[] };

/** Applied in order until the line fits: [segment, variant index]. */
export const SHRINK_STEPS: [SegmentId, number][] = [
	["path", 1], // fish-style ~/.p/agent
	["statuses", 1], // drop other extensions' statuses
	["usage", 1], // drop the usage extension
	["path", 2], // last directory only
	["branch", 1],
	["name", 1],
	["stats", 1], // context only, without cost and cache
	["thinking", 1],
];

// ── Pure helpers (exported for tests) ────────────────────────────────────────

export function homePath(cwd: string, home = process.env.HOME): string {
	if (!home) return cwd;
	const rel = relative(resolve(home), resolve(cwd));
	if (rel === "") return "~";
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return cwd;
	return `~${sep}${rel}`;
}

/** ~/.pi/agent/extensions → ~/.p/a/extensions, like fish's prompt_pwd. */
export function fishPath(path: string): string {
	const parts = path.split(sep);
	return parts.map((part, i) => (i === parts.length - 1 || part === "" || part === "~" ? part : part.startsWith(".") ? part.slice(0, 2) : part.slice(0, 1))).join(sep);
}

export function lastDir(path: string): string {
	return path === "~" || path === sep ? path : basename(path);
}

export function formatTokens(n: number): string {
	if (n < 1_000) return `${n}`;
	if (n < 10_000) return `${(n / 1_000).toFixed(1)}k`;
	if (n < 1_000_000) return `${Math.round(n / 1_000)}k`;
	if (n < 10_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	return `${Math.round(n / 1_000_000)}M`;
}

export function formatCost(cost: number): string {
	if (cost < 1) return `$${cost.toFixed(3)}`;
	if (cost < 100) return `$${cost.toFixed(2)}`;
	return `$${Math.round(cost)}`;
}

const THINKING_SHORT: Record<ThinkingLevel, string> = { off: "off", minimal: "min", low: "low", medium: "med", high: "high", xhigh: "xhigh", max: "max" };
const THINKING_COLOR = { off: "thinkingOff", minimal: "thinkingMinimal", low: "thinkingLow", medium: "thinkingMedium", high: "thinkingHigh", xhigh: "thinkingXhigh", max: "thinkingMax" } as const;

export function sanitizeStatus(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

/** Joins the non-empty variants currently selected for each segment. */
function joinSegments(segments: Segment[], level: Map<SegmentId, number>, separator: string): string {
	return segments
		.map((s) => s.variants[Math.min(level.get(s.id) ?? 0, s.variants.length - 1)])
		.filter((text) => text !== "")
		.join(separator);
}

/** Lays out left and right groups on one line, shrinking segments in SHRINK_STEPS order until it fits. */
export function fitLine(left: Segment[], right: Segment[], width: number, separator: string, steps = SHRINK_STEPS): string {
	const level = new Map<SegmentId, number>();
	const build = () => {
		const l = joinSegments(left, level, separator);
		const r = joinSegments(right, level, separator);
		return { l, r, need: visibleWidth(l) + (r ? MIN_GAP + visibleWidth(r) : 0) };
	};
	let line = build();
	for (const [id, variant] of steps) {
		if (line.need <= width) break;
		if ((level.get(id) ?? 0) < variant) level.set(id, variant);
		line = build();
	}
	if (line.need > width) {
		// Still too wide: keep the left side whole if possible, then truncate.
		const room = width - visibleWidth(line.l) - MIN_GAP;
		const r = room > 0 ? truncateToWidth(line.r, room, "…") : "";
		return truncateToWidth(r ? line.l + " ".repeat(Math.max(MIN_GAP, width - visibleWidth(line.l) - visibleWidth(r))) + r : line.l, width, "…");
	}
	return line.l + " ".repeat(width - visibleWidth(line.l) - visibleWidth(line.r)) + line.r;
}

/** Context color relative to the auto-compaction threshold (or the window when it is off). */
export function contextSeverity(tokens: number | null, window: number, reserve: number, autoCompact: boolean): "ok" | "warn" | "bad" {
	if (tokens === null || window <= 0) return "ok";
	const threshold = Math.max(1, window - reserve);
	if (tokens >= threshold) return autoCompact ? "warn" : "bad";
	return tokens >= threshold * CONTEXT_WARN ? "warn" : "ok";
}

/** Returns the cache hit rate only when it is worth showing. */
export function cacheAlert(hitRate: number | undefined, repliesSinceCompaction: number): number | undefined {
	if (hitRate === undefined || repliesSinceCompaction < CACHE_WARMUP) return undefined;
	return hitRate < CACHE_WARN ? hitRate : undefined;
}

// ── Session data ─────────────────────────────────────────────────────────────

type Stats = { cost: number; usesCache: boolean; hitRate?: number; repliesSinceCompaction: number };

function promptTokens(u: Usage): number {
	return u.input + u.cacheRead + u.cacheWrite;
}

/** Totals over every entry (like Pi's footer); cache data from the current branch only. */
export function computeStats(entries: any[], branch: any[]): Stats {
	let cost = 0;
	let usesCache = false;
	for (const e of entries) {
		const usage: Usage | undefined =
			e.type === "usage" ? e.usage
			: e.type === "message" && (e.message?.role === "assistant" || e.message?.role === "toolResult") ? e.message.usage
			: (e.type === "branch_summary" || e.type === "compaction") ? e.usage
			: undefined;
		if (!usage) continue;
		cost += usage.cost?.total ?? 0;
		if (usage.cacheRead > 0 || usage.cacheWrite > 0) usesCache = true;
	}
	let hitRate: number | undefined;
	let repliesSinceCompaction = 0;
	for (const e of branch) {
		if (e.type === "compaction") {
			repliesSinceCompaction = 0;
			hitRate = undefined;
		} else if (e.type === "message" && e.message?.role === "assistant" && e.message.usage) {
			repliesSinceCompaction++;
			const prompt = promptTokens(e.message.usage);
			hitRate = prompt > 0 ? (e.message.usage.cacheRead / prompt) * 100 : undefined;
		}
	}
	return { cost, usesCache, hitRate, repliesSinceCompaction };
}

function readCompaction(path: string): CompactionSettings {
	try {
		return JSON.parse(readFileSync(path, "utf8"))?.compaction ?? {};
	} catch {
		return {};
	}
}

// ── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let ctx: ExtensionContext | undefined;
	let requestRender = () => {};
	let globalCompaction: CompactionSettings = {};
	let projectCompaction: CompactionSettings = {};
	let watchers: FSWatcher[] = [];
	let statsCache: { key: string; stats: Stats; context: ReturnType<ExtensionContext["getContextUsage"]> } | undefined;

	const globalSettings = () => join(getAgentDir(), "settings.json");
	const projectDir = (c: ExtensionContext) => join(c.sessionManager.getCwd(), CONFIG_DIR_NAME);

	function loadSettings(c: ExtensionContext) {
		globalCompaction = readCompaction(globalSettings());
		projectCompaction = readCompaction(join(projectDir(c), "settings.json"));
	}

	function watchSettings(c: ExtensionContext) {
		stopWatching();
		for (const dir of new Set([getAgentDir(), projectDir(c)])) {
			try {
				// Watch the directory: settings are saved by rename, which a file watch would lose.
				watchers.push(watch(dir, (_event, file) => {
					if (file !== "settings.json" || !ctx) return;
					loadSettings(ctx);
					requestRender();
				}));
			} catch {
				// The project .pi directory usually does not exist.
			}
		}
	}

	function stopWatching() {
		for (const w of watchers) w.close();
		watchers = [];
	}

	function autoCompact(): boolean {
		return projectCompaction.enabled ?? globalCompaction.enabled ?? true;
	}

	function reserveTokens(c: ExtensionContext): number {
		const key = c.model ? `${c.model.provider}/${c.model.id}` : "";
		return (
			projectCompaction.modelOverrides?.[key]?.reserveTokens ??
			globalCompaction.modelOverrides?.[key]?.reserveTokens ??
			projectCompaction.reserveTokens ??
			globalCompaction.reserveTokens ??
			DEFAULT_RESERVE_TOKENS
		);
	}

	function sessionData(c: ExtensionContext) {
		const sm = c.sessionManager;
		const entries = sm.getEntries();
		const key = `${sm.getSessionId()}|${sm.getLeafId()}|${entries.length}|${c.model?.provider}/${c.model?.id}`;
		if (statsCache?.key !== key) statsCache = { key, stats: computeStats(entries, sm.getBranch()), context: c.getContextUsage() };
		return statsCache;
	}

	function isSubscription(c: ExtensionContext): boolean {
		if (!c.model) return false;
		if (c.model.provider === "kimi-coding") return true;
		try {
			return c.modelRegistry.isUsingOAuth(c.model);
		} catch {
			return false;
		}
	}

	function render(c: ExtensionContext, theme: Theme, footerData: any, width: number): string {
		const sep = theme.fg("dim", " · ");
		const { stats, context } = sessionData(c);

		// Left: session name, path, branch, usage extension, usage + context
		const name = c.sessionManager.getSessionName();
		const path = homePath(c.sessionManager.getCwd());
		const branch = footerData.getGitBranch();
		const statuses: Map<string, string> = footerData.getExtensionStatuses();
		const usageExt = USAGE_STATUS_KEYS.map((k) => statuses.get(k)).filter(Boolean).map((s) => sanitizeStatus(s!)).join(" ");
		const others = [...statuses.entries()]
			.filter(([k]) => !USAGE_STATUS_KEYS.includes(k))
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([, text]) => sanitizeStatus(text))
			.filter(Boolean)
			.join(sep);

		const window = context?.contextWindow ?? c.model?.contextWindow ?? 0;
		const tokens = context?.tokens ?? null;
		const auto = autoCompact();
		const severity = contextSeverity(tokens, window, reserveTokens(c), auto);
		const percent = context?.percent != null ? `${Math.round(context.percent)}%` : "?";
		const contextColor = severity === "bad" ? "error" : severity === "warn" ? "warning" : "muted";
		const contextText = theme.fg(contextColor, `${percent}/${formatTokens(window)}`) + " " + (auto ? theme.fg("dim", "↻") : theme.fg("warning", "⊘"));

		const extras: string[] = [];
		if (stats.cost > 0 && !isSubscription(c)) extras.push(theme.fg("success", formatCost(stats.cost)));
		const hit = stats.usesCache ? cacheAlert(stats.hitRate, stats.repliesSinceCompaction) : undefined;
		if (hit !== undefined) extras.push(theme.fg(hit < CACHE_BAD ? "error" : "warning", `CH${Math.round(hit)}%`));

		const left: Segment[] = [
			{ id: "name", variants: name ? [theme.bold(theme.fg("accent", name)), ""] : [""] },
			{ id: "path", variants: [path, fishPath(path), lastDir(path)].map((p) => theme.fg("muted", p)) },
			{ id: "branch", variants: branch ? [theme.fg("syntaxKeyword", branch), ""] : [""] },
			{ id: "usage", variants: usageExt ? [usageExt, ""] : [""] },
			{ id: "stats", variants: [[...extras, contextText].join(" "), contextText] },
		];

		// Right: other statuses, model, thinking level
		const model = c.model;
		const level = (pi.getThinkingLevel() ?? "off") as ThinkingLevel;
		const thinkingColor = (THINKING_COLOR[level] ?? "muted") as Parameters<Theme["fg"]>[0];
		const right: Segment[] = [
			{ id: "statuses", variants: others ? [others, ""] : [""] },
			{ id: "model", variants: [theme.fg("text", model?.id ?? "no-model")] },
			{ id: "thinking", variants: model?.reasoning ? [theme.fg(thinkingColor, THINKING_SHORT[level] ?? level), ""] : [""] },
		];

		const pad = width > PADDING * 2 + 10 ? PADDING : 0;
		const inner = fitLine(left, right, width - pad * 2, sep);
		return " ".repeat(pad) + inner + " ".repeat(pad);
	}

	function install(c: ExtensionContext) {
		if (!c.hasUI) return;
		if (!enabled) return c.ui.setFooter(undefined);
		c.ui.setFooter((tui, theme, footerData) => {
			requestRender = () => tui.requestRender();
			const unsubscribe = footerData.onBranchChange(requestRender);
			return {
				dispose: unsubscribe,
				invalidate() {},
				render(width: number): string[] {
					if (!ctx) return [];
					try {
						return [render(ctx, theme, footerData, width)];
					} catch (error) {
						return [truncateToWidth(theme.fg("error", `footer: ${error instanceof Error ? error.message : String(error)}`), width)];
					}
				},
			};
		});
	}

	pi.on("session_start", async (_event, c) => {
		ctx = c;
		statsCache = undefined;
		loadSettings(c);
		watchSettings(c);
		install(c);
	});

	pi.on("session_shutdown", async () => {
		stopWatching();
	});

	// The TUI usually re-renders on these anyway; this makes sure the footer follows.
	for (const event of ["model_select", "thinking_level_select", "session_info_changed", "turn_end", "session_compact"] as const) {
		pi.on(event as any, async (_event: unknown, c: ExtensionContext) => {
			ctx = c;
			requestRender();
		});
	}

	pi.registerCommand("footer", {
		description: "Toggle between the custom one-line footer and Pi's built-in footer",
		handler: async (_args, c) => {
			enabled = !enabled;
			ctx = c;
			install(c);
			c.ui.notify(enabled ? "Custom footer enabled" : "Built-in footer restored", "info");
		},
	});
}
