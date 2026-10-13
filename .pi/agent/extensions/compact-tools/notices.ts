import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export type Assistant = Extract<AgentMessage, { role: "assistant" }>;
export type CacheReadPrice = (provider: string, model: string) => number;

/**
 * Mirrors Pi 1.0.2's visible-cache-notice thresholds using public session/model
 * data. Its internal cache-stat helpers are not exported to extensions. A setting
 * being enabled is not itself a visible boundary.
 */
class CacheNotices {
	private previous?: { promptTokens: number; reportedCache: boolean };

	constructor(private readPrice: CacheReadPrice) {}

	observe(entry: SessionEntry): boolean {
		if (entry.type === "compaction" || entry.type === "branch_summary") {
			this.previous = undefined;
		} else if (entry.type === "usage" && entry.kind === "cache_warm") {
			const usage = entry.usage;
			const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
			if (promptTokens > 0) this.previous = { promptTokens, reportedCache: true };
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			return this.assistant(entry.message);
		}
		return false;
	}

	assistant(message: Assistant): boolean {
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
		return visible;
	}
}

export function collectCacheNotices(entries: readonly SessionEntry[], readPrice: CacheReadPrice): Set<Assistant> {
	const scan = new CacheNotices(readPrice);
	const messages = new Set<Assistant>();
	for (const entry of entries) {
		if (scan.observe(entry) && entry.type === "message" && entry.message.role === "assistant") messages.add(entry.message);
	}
	return messages;
}

export function hasCacheNotice(entries: readonly SessionEntry[], message: Assistant, readPrice: CacheReadPrice): boolean {
	const scan = new CacheNotices(readPrice);
	// message_end normally precedes persistence; skipping the same object also
	// keeps this usable by clients that already persisted their current snapshot.
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message !== message) scan.observe(entry);
	}
	return scan.assistant(message);
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
