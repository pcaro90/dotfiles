import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentToolResult, ToolRenderers } from "@earendil-works/pi-coding-agent";

export type RenderContext = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];

export const TIMINGS_ENTRY = "compact-tools:timings";
export const SETTINGS_ENTRY = "compact-tools:settings";
const BUILT_INS = new Set(["read", "bash", "edit", "write", "codemode", "tool_search"]);
const TIMED_TOOLS = new Set(["bash", "codemode"]);
const IMAGE_PATH = /\.(png|jpe?g|gif|webp|bmp)(?:$|[?#])/i;

export function showsDuration(name: string): boolean {
	return TIMED_TOOLS.has(name);
}

export function supportsTool(name: string): boolean {
	return BUILT_INS.has(name) || name.startsWith("mcp__");
}

export interface ToolGroup {
	rows: ToolRow[];
}

export interface ToolRow {
	id: string;
	name: string;
	order: number;
	args: Record<string, unknown>;
	group: ToolGroup;
	result?: AgentToolResult<unknown>;
	isError: boolean;
	isPartial: boolean;
	executionStarted: boolean;
	argsComplete: boolean;
	startedAt?: number;
	durationMs?: number;
	globalExpanded: boolean;
	localExpanded?: boolean;
	context?: RenderContext;
	original?: ToolRenderers;
	body?: { call: import("@earendil-works/pi-tui").Component; result?: import("@earendil-works/pi-tui").Component };
	bodyState: Record<string, unknown>;
}

type Assistant = Extract<AgentMessage, { role: "assistant" }>;

function hasVisibleContent(message: Assistant): boolean {
	// Hidden thinking still produces Pi's visible "Thinking…" row. /\S/ stops at the first
	// visible character instead of copying the whole streamed text like trim().
	return message.stopReason === "length" || message.content.some((part) => (part.type === "text" && /\S/.test(part.text)) || (part.type === "thinking" && /\S/.test(part.thinking)));
}

function isImageRead(name: string, args: Record<string, unknown>): boolean {
	return name === "read" && IMAGE_PATH.test(String(args.path ?? args.file_path ?? ""));
}

function hasImage(row: ToolRow): boolean {
	return !!row.result?.content.some((part) => part.type === "image") || isImageRead(row.name, row.args);
}

/** Everything grouping depends on; streaming deltas that keep it unchanged need no regrouping. */
function groupingSignature(message: Assistant): string {
	return `${hasVisibleContent(message)}|${message.content.map((part) => part.type === "toolCall" ? `${part.id}:${part.name}:${isImageRead(part.name, part.arguments)}` : "").join(",")}`;
}

/** Only presentation state: no tool execution, transcript rewriting, or result truncation. */
export class ToolStore {
	readonly rows = new Map<string, ToolRow>();
	private tail?: ToolGroup;
	private message?: { previous?: ToolGroup; groups: Map<string, ToolGroup>; signature?: string };
	private sequence = 0;

	clear(): void {
		this.rows.clear();
		this.tail = undefined;
		this.message = undefined;
		this.sequence = 0;
	}

	breakGroup(): void {
		this.tail = undefined;
		this.message = undefined;
	}

	beginAssistant(): void {
		this.message = { previous: this.tail, groups: new Map() };
	}

	endAssistant(hasTrailingNotice = false): void {
		this.message = undefined;
		// Model-message/turn boundaries are invisible. Only a notice that Pi really
		// displays after this call block prevents the next block from joining it.
		if (hasTrailingNotice) this.tail = undefined;
	}

	ensure(id: string, name: string, args: unknown = {}): ToolRow {
		let row = this.rows.get(id);
		if (!row) {
			const group: ToolGroup = { rows: [] };
			row = {
				id, name, args: {}, order: this.sequence++, group,
				isError: false, isPartial: true, executionStarted: false, argsComplete: false,
				globalExpanded: false, bodyState: {},
			};
			group.rows.push(row);
			this.rows.set(id, row);
		}
		row.name = name;
		row.args = args && typeof args === "object" ? args as Record<string, unknown> : {};
		return row;
	}

	/** Observe complete snapshots, including streaming arguments and late text. */
	observeAssistant(message: Assistant): void {
		if (!this.message) this.beginAssistant();
		const current = this.message!;
		const signature = groupingSignature(message);
		if (signature === current.signature) {
			for (const part of message.content) {
				if (part.type === "toolCall" && this.rows.has(part.id)) this.ensure(part.id, part.name, part.arguments);
			}
			return;
		}
		current.signature = signature;
		const visible = hasVisibleContent(message);
		let canJoin = !visible;
		let segment: ToolRow[] = [];
		let lastGroup: ToolGroup | undefined = visible ? undefined : current.previous;

		const flush = (standalone = false): void => {
			if (!segment.length) return;
			const key = segment[0].id;
			let group = current.groups.get(key);
			if (canJoin && !standalone && current.previous) {
				group = current.previous;
			} else if (!group || group === current.previous) {
				group = { rows: [] };
			}
			current.groups.set(key, group);
			for (const row of segment) this.assign(row, group);
			lastGroup = standalone ? undefined : group;
			segment = [];
			canJoin = false;
		};

		for (const part of message.content) {
			if (part.type !== "toolCall") continue;
			if (!supportsTool(part.name)) {
				flush();
				canJoin = false;
				lastGroup = undefined;
				continue;
			}
			const row = this.ensure(part.id, part.name, part.arguments);
			if (hasImage(row)) {
				flush();
				canJoin = false;
				segment.push(row);
				flush(true);
			} else {
				segment.push(row);
			}
		}
		flush();
		this.tail = lastGroup;
	}

	private assign(row: ToolRow, group: ToolGroup): void {
		if (row.group === group) return;
		row.group.rows = row.group.rows.filter((other) => other !== row);
		row.group = group;
		group.rows.push(row);
		group.rows.sort((a, b) => a.order - b.order);
	}

	setResult(row: ToolRow, result: AgentToolResult<unknown>, isPartial: boolean, isError: boolean): void {
		row.result = { ...row.result, ...result };
		row.isPartial = isPartial;
		row.isError = isError;
		row.body = undefined;
		// Native Pi draws images outside renderCall/renderResult. Keep image calls at
		// their original transcript position rather than moving them into an anchor.
		if (hasImage(row) && row.group.rows.length > 1) {
			const old = row.group;
			const index = old.rows.indexOf(row);
			const after = old.rows.slice(index + 1);
			this.assign(row, { rows: [] });
			const following: ToolGroup = { rows: [] };
			for (const other of after) this.assign(other, following);
			if (this.tail === old) this.tail = after.length ? following : undefined;
		}
	}

	capture(row: ToolRow, context: RenderContext, original?: ToolRenderers): void {
		if (row.globalExpanded !== context.expanded) {
			row.globalExpanded = context.expanded;
			row.localExpanded = undefined;
		}
		row.context = context;
		row.original = original;
		row.executionStarted = context.executionStarted;
		row.argsComplete = context.argsComplete;
		row.isPartial = context.isPartial;
		row.isError = context.isError;
		row.body = undefined;
	}

	expanded(row: ToolRow): boolean {
		return row.localExpanded ?? row.globalExpanded;
	}

	toggle(row: ToolRow): void {
		row.localExpanded = !this.expanded(row);
		row.body = undefined;
		this.redraw(row);
	}

	redraw(row: ToolRow): void {
		// The anchor renders live shared state, so one host invalidation is enough.
		(row.group.rows[0]?.context ?? row.context)?.invalidate();
	}

	resetLocalExpansion(): void {
		for (const row of this.rows.values()) {
			row.localExpanded = undefined;
			row.body = undefined;
		}
	}
}
