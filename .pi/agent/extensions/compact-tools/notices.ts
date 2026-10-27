import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export type Assistant = Extract<AgentMessage, { role: "assistant" }>;
export type CacheReadPrice = (provider: string, model: string) => number;

/**
 * Mirrors Pi 1.0.2's visible-cache-notice thresholds using public session/model
 * data. Its internal cache-stat helpers are not exported to extensions. A setting
 * being enabled is not itself a visible boundary.
 *
 * Incremental: catchUp() only reads entries appended since its last call, so
 * checking each new message does not rescan the whole session.
 */
export class CacheNotices {
	private previous?: { promptTokens: number; reportedCache: boolean };
	private cursor = 0;
	// A message checked at message_end is not counted again when its entry is persisted (and vice versa).
	private results = new WeakMap<Assistant, boolean>();

	constructor(private readPrice: CacheReadPrice) {}

	/** Observes new entries and returns the assistant messages among them that show a notice. */
	catchUp(entries: readonly SessionEntry[]): Set<Assistant> {
		const visible = new Set<Assistant>();
		for (; this.cursor < entries.length; this.cursor++) {
			const entry = entries[this.cursor];
			if (entry.type === "compaction" || entry.type === "branch_summary") {
				this.previous = undefined;
			} else if (entry.type === "usage" && entry.kind === "cache_warm") {
				const usage = entry.usage;
				const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
				if (promptTokens > 0) this.previous = { promptTokens, reportedCache: true };
			} else if (entry.type === "message" && entry.message.role === "assistant" && !this.results.has(entry.message) && this.assistant(entry.message)) {
				visible.add(entry.message);
			}
		}
		return visible;
	}

	/** Whether a message that follows `entries` shows a notice. */
	check(entries: readonly SessionEntry[], message: Assistant): boolean {
		this.catchUp(entries);
		return this.assistant(message);
	}

	private assistant(message: Assistant): boolean {
		const known = this.results.get(message);
		if (known !== undefined) return known;
		const usage = message.usage;
		if (!usage) return false;
		const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
		const previous = this.previous;
		let visible = false;
		if (previous && promptTokens > 0 && (usage.cacheRead + usage.cacheWrite > 0 || previous.reportedCache)) {
			const missedTokens = Math.min(previous.promptTokens, promptTokens) - usage.cacheRead;
			if (missedTokens > 1024) {
				const paidTokens = usage.input + usage.cacheWrite;
				const paidRate = paidTokens > 0 ? (usage.cost.input + usage.cost.cacheWrite) / paidTokens : 0;
				const readRate = usage.cacheRead > 0 ? usage.cost.cacheRead / usage.cacheRead : this.readPrice(message.provider, message.model) / 1_000_000;
				const missedCost = missedTokens * Math.max(0, paidRate - readRate);
				visible = missedTokens >= 20_000 || missedCost >= 0.1;
			}
		}
		if (promptTokens > 0) {
			this.previous = { promptTokens, reportedCache: (previous?.reportedCache ?? false) || usage.cacheRead + usage.cacheWrite > 0 };
		}
		this.results.set(message, visible);
		return visible;
	}
}

function droppedThinking(message: Assistant): number {
	let count = 0;
	for (const diagnostic of message.diagnostics ?? []) {
		if (diagnostic.type !== "anthropic_input_transformations") continue;
		const transformations = diagnostic.details?.transformations;
		if (!Array.isArray(transformations)) continue;
		count += transformations.filter((item) => item && typeof item === "object" && item.type === "thinking_dropped").length;
	}
	return count;
}

export function hasThinkingDropNotice(branch: readonly SessionEntry[], message: Assistant): boolean {
	const count = droppedThinking(message);
	if (!count) return false;
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "message" && entry.message.role === "assistant" && entry.message !== message) {
			return count > droppedThinking(entry.message);
		}
	}
	return true;
}

export function canShowAssistantNotice(message: Assistant): boolean {
	return message.stopReason !== "error" && message.stopReason !== "aborted";
}
