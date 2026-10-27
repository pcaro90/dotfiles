import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, sliceByColumn, truncateToWidth, visibleWidth, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { describeRow, displayTitle, formatDuration } from "./format.js";
import { showsDuration, type RenderContext, type ToolRow, ToolStore } from "./model.js";

export const EMPTY: Component = { render: () => [], invalidate() {} };
export const NARROW_WIDTH = 80;

function fit(text: string, width: number, keepEnd = false): string {
	if (width <= 0) return "";
	if (visibleWidth(text) <= width) return text;
	return keepEnd && width > 1 ? `…${sliceByColumn(text, visibleWidth(text) - width + 1, width - 1)}` : truncateToWidth(text, width, "…");
}

function background(row: ToolRow): "toolPendingBg" | "toolErrorBg" | "toolSuccessBg" {
	return row.isPartial ? "toolPendingBg" : row.isError ? "toolErrorBg" : "toolSuccessBg";
}

function paint(line: string, width: number, row: ToolRow, theme: Theme): string {
	const clipped = truncateToWidth(line, width, "…");
	return theme.bg(background(row), clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped))));
}

export function renderHeader(row: ToolRow, store: ToolStore, theme: Theme, width: number, toolWidth = 8): string {
	if (width <= 0) return "";
	const description = describeRow(row);
	const expanded = store.expanded(row);
	const status = row.isPartial ? (row.executionStarted ? "◌" : "…") : row.isError ? "✗" : "✓";
	const color = row.isPartial ? "warning" : row.isError ? "error" : "success";
	const narrow = width < NARROW_WIDTH;
	const title = displayTitle(row);
	const fittedTitle = narrow ? title : fit(title, toolWidth);
	const tool = fittedTitle + (narrow ? "" : " ".repeat(Math.max(0, toolWidth - visibleWidth(fittedTitle))));
	const titleColor = description.readKind === "skill" ? "customMessageLabel" : "toolTitle";
	const prefix = (narrow ? "" : ` ${theme.fg("muted", expanded ? "▾" : "▸")} `) + `${theme.fg(color, status)} ${theme.fg(titleColor, theme.bold(tool))} `;
	const duration = showsDuration(row.name) ? row.durationMs ?? (row.startedAt !== undefined && row.isPartial ? performance.now() - row.startedAt : undefined) : undefined;
	const clock = duration === undefined ? "" : formatDuration(duration);
	const clockSpace = clock ? visibleWidth(clock) + (narrow ? 1 : 2) : narrow ? 0 : 1;
	const available = Math.max(0, width - visibleWidth(prefix) - clockSpace);
	const separator = narrow ? " " : " · ";
	const minimumPrimary = Math.min(8, visibleWidth(description.primary));
	const metadataWidth = description.primary ? Math.max(0, Math.min(available - minimumPrimary - separator.length, Math.floor(available / 2))) : available;
	const metadata = fit(description.metadata, metadataWidth);
	const primaryWidth = Math.max(0, available - (metadata && description.primary ? visibleWidth(metadata) + separator.length : 0));
	const primary = fit(description.primary, primaryWidth, description.path);
	let line = prefix + theme.fg(description.readKind === "skill" ? "customMessageText" : "accent", primary);
	if (metadata) line += (primary ? theme.fg("muted", separator) : "") + theme.fg(row.isError ? "error" : description.warning ? "warning" : "dim", metadata);
	const clockGap = narrow ? (primary || metadata ? " " : "") : "  ";
	if (clock && visibleWidth(line) + visibleWidth(clock) + clockGap.length <= width) {
		line += narrow ? clockGap + theme.fg("dim", clock) : " ".repeat(width - visibleWidth(line) - visibleWidth(clock) - 1) + theme.fg("dim", clock) + " ";
	}
	return paint(line, width, row, theme);
}

function fallbackCall(row: ToolRow, theme: Theme): Component {
	return new Text(theme.fg("toolOutput", `${row.name}\n${JSON.stringify(row.args, null, 2)}`), 0, 0);
}

function fallbackResult(row: ToolRow, theme: Theme): Component {
	const text = row.result?.content.filter((part) => part.type === "text").map((part) => part.text).join("\n") ?? "";
	return new Text(theme.fg(row.isError ? "error" : "toolOutput", text), 0, 0);
}

function body(row: ToolRow, store: ToolStore, theme: Theme): NonNullable<ToolRow["body"]> {
	if (row.body) return row.body;
	const context: RenderContext = {
		...row.context!, args: row.args, state: row.bodyState, expanded: true,
		lastComponent: undefined, isPartial: row.isPartial, isError: row.isError,
		invalidate: () => { row.body = undefined; store.redraw(row); },
		// We own the clock. Don't start a second shell-renderer timer, and don't
		// recompute edit previews against files that have already been modified.
		executionStarted: row.name === "bash" ? false : row.executionStarted,
		argsComplete: row.name === "edit" ? false : row.argsComplete,
	};
	let call: Component;
	let result: Component | undefined;
	try {
		call = row.name === "edit" && (!row.result || row.isPartial)
			? fallbackCall(row, theme)
			: row.original?.renderCall?.(row.args, theme, context) ?? fallbackCall(row, theme);
		if (row.result) {
			result = row.original?.renderResult?.(row.result, { expanded: true, isPartial: row.isPartial }, theme, context) ?? fallbackResult(row, theme);
		}
	} catch {
		// A third-party renderer must not make the call's original data inaccessible.
		call = fallbackCall(row, theme);
		result = fallbackResult(row, theme);
	}
	row.body = { call, result };
	return row.body;
}

/** Each native call keeps its slot. Only the first slot draws the shared block. */
export class GroupSlot implements Component {
	private layout: { row: ToolRow; start: number; end: number }[] = [];

	constructor(private store: ToolStore, private row: ToolRow, private theme: Theme) {}

	render(width: number): string[] {
		this.layout = [];
		if (width <= 0 || this.row.group.rows[0] !== this.row) return [];
		const rows = this.row.group.rows;
		const toolWidth = Math.min(20, Math.max(8, ...rows.map((row) => visibleWidth(displayTitle(row)))));
		const lines: string[] = [];
		for (const row of rows) {
			const start = lines.length;
			lines.push(renderHeader(row, this.store, this.theme, width, toolWidth));
			if (this.store.expanded(row) && row.context) {
				const components = body(row, this.store, this.theme);
				const innerWidth = Math.max(1, width - 4);
				const detail = [...components.call.render(innerWidth), ...(components.result?.render(innerWidth) ?? [])];
				while (detail.length && !detail[0].trim()) detail.shift();
				while (detail.length && !detail.at(-1)!.trim()) detail.pop();
				for (const line of detail) lines.push(paint(`    ${line}`, width, row, this.theme));
			}
			this.layout.push({ row, start, end: lines.length });
		}
		return lines;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "click" || event.button !== "left") return undefined;
		const target = this.layout.find(({ start, end }) => event.y >= start && event.y < end);
		if (!target) return undefined;
		this.store.toggle(target.row);
		return { handled: true, render: true };
	}

	invalidate(): void {
		this.layout = [];
		for (const row of this.row.group.rows) row.body = undefined;
	}
}
