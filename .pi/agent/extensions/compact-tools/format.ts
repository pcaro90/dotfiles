import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { getReadmePath } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { ToolRow } from "./model.js";

const RESOURCE_NAMES = new Set(["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]);
const PI_ROOT = dirname(getReadmePath());
const SCRIPT_HEADER = /^Script (completed|failed)\nWall time [\d.]+ seconds\nOutput:\n$/;

export function singleLine(value: unknown): string {
	return stripTerminalSequences(String(value ?? "")).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
}

export function lineCount(text: string): number {
	if (!text) return 0;
	return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

export function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const seconds = Math.floor(ms / 1000);
	return seconds < 3600 ? `${Math.floor(seconds / 60)}m${seconds % 60}s` : `${Math.floor(seconds / 3600)}h${Math.floor(seconds / 60) % 60}m`;
}

export function shortenPath(value: unknown, cwd?: string): string {
	const path = singleLine(value);
	if (!isAbsolute(path)) return path || "…";
	if (cwd) {
		const local = relative(cwd, path);
		if (local && local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local)) return local;
	}
	const home = homedir();
	return path === home ? "~" : path.startsWith(`${home}${sep}`) ? `~${path.slice(home.length)}` : path;
}

interface ReadPresentation {
	title: string;
	label: string;
	kind?: "skill" | "resource" | "docs";
}

/** Same classifications and labels as Pi's read renderer, without its expand hint. */
export function readPresentation(row: ToolRow): ReadPresentation {
	const raw = row.args.file_path ?? row.args.path;
	const fallback = { title: "read", label: shortenPath(raw, row.context?.cwd) };
	if (typeof raw !== "string" || !raw) return fallback;
	let path = raw.replace(/^@/, "").replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, " ");
	if (path === "~") path = homedir();
	else if (path.startsWith("~/")) path = homedir() + path.slice(1);
	if (path.startsWith("file://")) {
		try { path = fileURLToPath(path); } catch { return fallback; }
	}
	const absolute = resolve(row.context?.cwd ?? process.cwd(), path);
	const fileName = basename(absolute);
	if (fileName === "SKILL.md") {
		return { title: "[skill]", label: singleLine(basename(dirname(absolute)) || fileName), kind: "skill" };
	}
	const docsPath = relative(PI_ROOT, absolute).split(sep).join("/");
	if (!isAbsolute(docsPath) && (docsPath === "README.md" || docsPath.startsWith("docs/") || docsPath.startsWith("examples/"))) {
		return { title: "read docs", label: singleLine(docsPath), kind: "docs" };
	}
	if (RESOURCE_NAMES.has(fileName)) {
		return { title: "read resource", label: shortenPath(absolute, row.context?.cwd), kind: "resource" };
	}
	return fallback;
}

export function displayTitle(row: ToolRow): string {
	return row.name === "read" ? readPresentation(row).title : singleLine(row.name);
}

function textOutput(row: ToolRow): string {
	return row.result?.content.filter((part) => part.type === "text").map((part) => part.text).join("\n") ?? "";
}

function details(row: ToolRow): Record<string, unknown> {
	const value = row.result?.details;
	return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

/** Logical output lines, excluding Pi's status/header/footer text. */
function outputLines(row: ToolRow): number {
	const detail = details(row);
	const truncation = detail.truncation as { truncated?: boolean; totalLines?: number } | undefined;
	if (truncation?.truncated && typeof truncation.totalLines === "number" && Number.isFinite(truncation.totalLines)) {
		return Math.max(0, truncation.totalLines);
	}
	const structured = row.result?.structuredContent;
	if (row.name === "bash" && structured && typeof structured === "object" && typeof (structured as { output?: unknown }).output === "string") {
		return lineCount((structured as { output: string }).output);
	}
	const content = row.result?.content ?? [];
	const blocks = row.name === "codemode" && content[0]?.type === "text" && SCRIPT_HEADER.test(content[0].text) ? content.slice(1) : content;
	let text = blocks.filter((part) => part.type === "text").map((part) => part.text).join("\n");
	if (row.name === "bash") {
		text = text.replace(/(?:\n\n)?Command exited with code \d+\s*$/, "");
	}
	if (typeof detail.fullOutputPath === "string") {
		const footer = text.lastIndexOf("\n\n[");
		if (footer >= 0 && text.slice(footer).includes(detail.fullOutputPath) && text.endsWith("]")) text = text.slice(0, footer);
	}
	return text === "(no output)" ? 0 : lineCount(text);
}

export interface Description {
	primary: string;
	metadata: string;
	path: boolean;
	warning: boolean;
	readKind?: ReadPresentation["kind"];
}

export function describeRow(row: ToolRow): Description {
	const args = row.args;
	const detail = details(row);
	const metadata: string[] = [];
	let primary = "…";
	let path = false;
	let warning = false;
	let readKind: ReadPresentation["kind"];
	const rawPath = args.file_path ?? args.path;

	switch (row.name) {
		case "read": {
			const presentation = readPresentation(row);
			primary = presentation.label;
			readKind = presentation.kind;
			path = readKind !== "skill";
			if (args.offset != null || args.limit != null) {
				const start = typeof args.offset === "number" ? args.offset : 1;
				primary += `:${start}${typeof args.limit === "number" ? `–${start + args.limit - 1}` : "–"}`;
			}
			break;
		}
		case "write":
			primary = shortenPath(rawPath, row.context?.cwd);
			path = true;
			if (typeof args.content === "string") metadata.push(`${lineCount(args.content)}L`);
			break;
		case "edit": {
			primary = shortenPath(rawPath, row.context?.cwd);
			path = true;
			if (typeof detail.diff === "string" && !row.isError) {
				const lines = detail.diff.split("\n");
				metadata.push(`+${lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length} -${lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length}`);
			} else if (Array.isArray(args.edits)) {
				metadata.push(`chg:${args.edits.length}`);
			}
			break;
		}
		case "bash": {
			const command = typeof args.command === "string" ? args.command : "";
			primary = singleLine(command.split("\n").find((line) => line.trim() && !line.trim().startsWith("#")) ?? command) || "…";
			const lines = lineCount(command);
			if (lines > 1) metadata.push(`s:${lines}`);
			if (row.result && !row.isPartial && !row.isError) {
				const output = outputLines(row);
				if (output) metadata.push(`o:${output}`);
			}
			break;
		}
		case "codemode": {
			const lines = typeof args.code === "string" ? lineCount(args.code) : undefined;
			primary = lines === undefined ? "…" : lines > 1 ? `s:${lines}` : "";
			if (Array.isArray(detail.calls) && detail.calls.length) {
				metadata.push(`c:${detail.calls.length}`);
				const errors = detail.calls.filter((call) => call && typeof call === "object" && (call as { status?: string }).status === "error").length;
				if (errors) {
					metadata.push(`e:${errors}`);
					warning = true;
				}
			}
			if (row.result && !row.isPartial && !row.isError) {
				const output = outputLines(row);
				if (output) metadata.push(`o:${output}`);
			}
			break;
		}
		case "tool_search":
			primary = singleLine(args.query ?? args.pattern) || "…";
			break;
		default: {
			const identity = args.path ?? args.file_path ?? args.url ?? args.query ?? args.name;
			primary = identity != null ? singleLine(identity) : Object.keys(args).join(", ") || "no args";
		}
	}

	if (row.isError) {
		const output = textOutput(row);
		const exit = output.match(/(?:Command exited with code|exit code[: ]+)\s*(\d+)/i);
		const reason = output.split("\n").filter((line) => line.trim() && !/^Script (failed|completed)$|^Wall time |^Output:$/.test(line)).at(-1);
		metadata.length = 0;
		metadata.push(exit ? `exit:${exit[1]}` : singleLine(reason) || "error");
	} else {
		const truncation = detail.truncation as { truncated?: boolean } | undefined;
		if (truncation?.truncated || detail.fullOutputPath) {
			metadata.push("trunc");
			warning = true;
		}
	}

	return { primary, metadata: metadata.join(" "), path, warning, readKind };
}
