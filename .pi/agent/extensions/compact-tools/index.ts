/** Compact tool rows + grouping. Phase 1: every call remains visible. */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { sessionEntryToContextMessages, type AgentToolResult, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GroupSlot, EMPTY } from "./render.js";
import { SETTINGS_ENTRY, TIMINGS_ENTRY, showsDuration, supportsTool, ToolStore } from "./model.js";
import { CacheNotices, canShowAssistantNotice, hasThinkingDropNotice } from "./notices.js";

export default function compactTools(pi: ExtensionAPI): void {
	const store = new ToolStore();
	let enabled = true;
	let tui = false;
	let entryCursor = 0;
	let timer: ReturnType<typeof setInterval> | undefined;
	const running = new Set<string>();
	const unpersisted = new Map<string, number>();
	let notices: CacheNotices | undefined;

	function cacheNotices(ctx: ExtensionContext): CacheNotices {
		return notices ??= new CacheNotices((provider, model) => ctx.modelRegistry.find(provider, model)?.cost.cacheRead ?? 0);
	}

	function stopClock(): void {
		if (timer) clearInterval(timer);
		timer = undefined;
	}

	function startClock(): void {
		if (timer) return;
		timer = setInterval(() => {
			const anchors = new Set<string>();
			for (const id of running) {
				const row = store.rows.get(id);
				const anchor = row?.group.rows[0];
				if (row && anchor && !anchors.has(anchor.id)) {
					anchors.add(anchor.id);
					store.redraw(row);
				}
			}
		}, 500);
		timer.unref?.();
	}

	function persistTimings(): void {
		if (!unpersisted.size) return;
		pi.appendEntry(TIMINGS_ENTRY, { durations: Object.fromEntries(unpersisted) });
		unpersisted.clear();
	}

	function resultMessage(message: Extract<AgentMessage, { role: "toolResult" }>): void {
		const row = store.rows.get(message.toolCallId);
		if (!row) return;
		store.setResult(row, { content: message.content, details: message.details }, false, message.isError);
	}

	function restore(ctx: ExtensionContext): void {
		stopClock();
		running.clear();
		unpersisted.clear();
		store.clear();
		notices = undefined;
		tui = ctx.mode === "tui";
		if (!tui) return;
		entryCursor = ctx.sessionManager.getEntries().length;
		const branch = ctx.sessionManager.getBranch();
		const settings = branch.findLast((entry) => entry.type === "custom" && entry.customType === SETTINGS_ENTRY);
		enabled = settings?.type === "custom" && typeof (settings.data as { enabled?: unknown } | undefined)?.enabled === "boolean"
			? (settings.data as { enabled: boolean }).enabled : true;
		const noticesEnabled = pi.getSettings().showCacheMissNotices ?? false;
		const restoredNotices = noticesEnabled ? cacheNotices(ctx).catchUp(ctx.sessionManager.getEntries()) : undefined;
		for (const entry of ctx.sessionManager.buildContextEntries()) {
			if (entry.type === "custom" && [SETTINGS_ENTRY, TIMINGS_ENTRY].includes(entry.customType)) continue;
			if (entry.type === "custom" || entry.type === "usage") {
				if (entry.type === "custom" || (noticesEnabled && entry.kind === "cache_warm")) store.breakGroup();
				continue;
			}
			for (const message of sessionEntryToContextMessages(entry)) {
				if (message.role === "assistant") {
					store.beginAssistant();
					store.observeAssistant(message);
					for (const part of message.content) {
						if (part.type !== "toolCall") continue;
						const row = store.rows.get(part.id);
						if (row) row.argsComplete = true;
					}
					store.endAssistant(canShowAssistantNotice(message) && (restoredNotices?.has(message) ?? false));
				} else if (message.role === "toolResult") {
					resultMessage(message);
				} else if (message.role !== "system" && !(message.role === "custom" && !message.display)) {
					store.breakGroup();
				}
			}
		}
		for (const entry of branch) {
			if (entry.type !== "custom" || entry.customType !== TIMINGS_ENTRY) continue;
			const durations = (entry.data as { durations?: unknown } | undefined)?.durations;
			if (!durations || typeof durations !== "object") continue;
			for (const [id, value] of Object.entries(durations)) {
				const row = store.rows.get(id);
				if (row && showsDuration(row.name) && typeof value === "number" && Number.isFinite(value) && value >= 0) row.durationMs = value;
			}
		}
	}

	pi.registerToolRenderer((name, next) => {
		const original = next();
		if (!tui || !enabled || !supportsTool(name)) return original;
		return {
			renderShell: "self",
			renderCall(args, theme, context) {
				const row = store.ensure(context.toolCallId, name, args);
				store.capture(row, context, original);
				return context.lastComponent instanceof GroupSlot ? context.lastComponent : new GroupSlot(store, row, theme);
			},
			renderResult(result, _options, _theme, context) {
				const row = store.ensure(context.toolCallId, name, context.args);
				store.capture(row, context, original);
				store.setResult(row, result, context.isPartial, context.isError);
				return EMPTY;
			},
		};
	});

	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("session_compact", (_event, ctx) => restore(ctx));
	pi.on("session_shutdown", () => {
		stopClock();
		running.clear();
		store.clear();
	});

	pi.on("message_start", (event, ctx) => {
		if (!enabled || ctx.mode !== "tui") return;
		// Cache-warming notices are inserted asynchronously, outside message events.
		// Only new, actually visible usage entries create a boundary.
		const entries = ctx.sessionManager.getEntries();
		if (pi.getSettings().showCacheMissNotices) {
			for (let i = entryCursor; i < entries.length; i++) {
				const entry = entries[i];
				if (entry.type === "usage" && entry.kind === "cache_warm") store.breakGroup();
			}
		}
		entryCursor = entries.length;
		if (event.message.role === "assistant") store.beginAssistant();
		else if (event.message.role === "user" || (event.message.role === "custom" && event.message.display)) store.breakGroup();
	});
	pi.on("message_update", (event, ctx) => {
		if (enabled && ctx.mode === "tui" && event.message.role === "assistant") store.observeAssistant(event.message);
	});
	pi.on("message_end", (event, ctx) => {
		if (!enabled || ctx.mode !== "tui") return;
		if (event.message.role === "assistant") {
			store.observeAssistant(event.message);
			const message = event.message;
			const visibleNotice = !!pi.getSettings().showCacheMissNotices && canShowAssistantNotice(message) && (
				cacheNotices(ctx).check(ctx.sessionManager.getEntries(), message) ||
				hasThinkingDropNotice(ctx.sessionManager.getBranch(), message)
			);
			store.endAssistant(visibleNotice);
		} else if (event.message.role === "toolResult") {
			resultMessage(event.message);
		}
	});
	pi.on("user_bash", () => { if (tui && enabled) store.breakGroup(); });

	pi.on("tool_execution_start", (event, ctx) => {
		if (!enabled || ctx.mode !== "tui" || event.parentToolCallId || !supportsTool(event.toolName)) return;
		const row = store.ensure(event.toolCallId, event.toolName, event.args);
		row.executionStarted = true;
		if (showsDuration(row.name)) {
			row.startedAt = performance.now();
			running.add(row.id);
			startClock();
		}
	});
	pi.on("tool_execution_end", (event, ctx) => {
		if (!enabled || ctx.mode !== "tui" || event.parentToolCallId) return;
		const row = store.rows.get(event.toolCallId);
		if (!row) return;
		if (showsDuration(row.name) && row.startedAt !== undefined) {
			row.durationMs = Math.max(0, performance.now() - row.startedAt);
			unpersisted.set(row.id, row.durationMs);
		}
		store.setResult(row, event.result as AgentToolResult<unknown>, false, event.isError);
		running.delete(row.id);
		if (!running.size) stopClock();
	});
	pi.on("turn_end", (_event, ctx) => { if (enabled && ctx.mode === "tui") persistTimings(); });
	pi.on("agent_end", (_event, ctx) => {
		stopClock();
		running.clear();
		if (enabled && ctx.mode === "tui") persistTimings();
	});

	pi.registerCommand("compact-tools", {
		description: "Compact tool display: on, off, expand, collapse (no burst folding yet)",
		getArgumentCompletions: (prefix) => ["on", "off", "expand", "collapse"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") return;
			const option = args.trim().toLowerCase();
			if (option === "expand" || option === "collapse") {
				store.resetLocalExpansion();
				ctx.ui.setToolsExpanded(option === "expand");
				return;
			}
			if (option !== "on" && option !== "off") {
				ctx.ui.notify(`Compact tools: ${enabled ? "on" : "off"}. /compact-tools on|off|expand|collapse`, "info");
				return;
			}
			const requested = option === "on";
			if (requested === enabled) return;
			await ctx.waitForIdle();
			pi.appendEntry(SETTINGS_ENTRY, { enabled: requested });
			// Rebuild native shells as well, so "off" restores Pi's exact default UI.
			await ctx.reload();
		},
	});
}
