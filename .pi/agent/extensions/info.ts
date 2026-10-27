/**
 * /info — session summary: tools (active/inactive), skills, prompt templates, extension
 * commands, loaded context files, system prompt size and session metadata.
 * `f`/Tab toggles full mode: descriptions and the complete system prompt.
 */
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const PAGE = 25;
const HELP = "  [q/Esc] close  |  [↑↓] scroll  |  [Space/PgDn] page  |  [f/Tab] full/summary  |  [Home/End]";

function infoLines(pi: ExtensionAPI, ctx: ExtensionCommandContext, theme: Theme, full: boolean): string[] {
	const lines = ["", theme.fg("accent", theme.bold(`  /info  ·  ${full ? "FULL" : "SUMMARY"}  ·  [f/Tab] toggle  ·  [q/Esc] close`)), "  " + theme.fg("accent", "━".repeat(50)), ""];
	const section = (title: string, body: string[], footer?: string) => {
		lines.push(theme.fg("accent", theme.bold(`  ▸ ${title}`)), "  " + theme.fg("dim", "─".repeat(45)));
		lines.push(...(body.length ? body : [theme.fg("dim", "    (none)")]));
		if (footer) lines.push(theme.fg("dim", `  ${footer}`));
		lines.push("");
	};
	const grouped = <T>(items: T[], group: (item: T) => string, rows: (item: T) => string[]) =>
		Object.entries(Object.groupBy(items, group)).flatMap(([name, members]) => [theme.fg("muted", `  ${name}`), ...members!.flatMap(rows)]);
	const describe = (text = "") => (!text ? "" : ` — ${full || text.length <= 70 ? text : `${text.slice(0, 70)}…`}`);

	const tools = pi.getAllTools();
	const active = new Set(pi.getActiveTools());
	const activeCount = tools.filter((tool) => active.has(tool.name)).length;
	section("Registered Tools", grouped(tools, (tool) => (tool.sourceInfo.source === "built-in" ? "built-in:" : "extension:"), (tool) => [
		`    ${active.has(tool.name) ? theme.fg("success", "✓ active") : theme.fg("muted", "○ inactive")} ${tool.name}${full && tool.description ? ` — ${tool.description}` : ""}`,
	]), `Total: ${tools.length}  |  Active: ${activeCount}  |  Inactive: ${tools.length - activeCount}`);

	const commands = pi.getCommands();
	for (const [title, source, prefix] of [["Available Skills", "skill", "/skill:"], ["Prompt Templates", "prompt", "/"]]) {
		const items = commands.filter((command) => command.source === source);
		section(title, grouped(items, (command) => `[${command.sourceInfo.scope}]`, (command) => [
			`    ${prefix}${command.name}${describe(command.description)}`,
			theme.fg("dim", `      ${command.sourceInfo.path}`),
		]), `Total: ${items.length}`);
	}
	const extensionCommands = commands.filter((command) => command.source === "extension");
	section("Extension Commands", extensionCommands.map((command) => `    /${command.name}${describe(command.description)}`), `Total: ${extensionCommands.length}`);

	const contextFiles = ctx.getSystemPromptOptions().contextFiles ?? [];
	section("Context Files", contextFiles.map((file) => `    ${theme.fg("success", "✓")} ${file.path}`), `Loaded: ${contextFiles.length}`);

	const prompt = ctx.getSystemPrompt();
	section("System Prompt", [`  Length: ${prompt.length.toLocaleString()} characters`, `  Est. tokens: ~${Math.ceil(prompt.length / 4).toLocaleString()}`]);
	const sessionFile = ctx.sessionManager.getSessionFile();
	section("Session", [`  CWD: ${ctx.cwd}`, ...(sessionFile ? [`  Session: ${sessionFile}`] : []), `  Entries: ${ctx.sessionManager.getEntries().length}`]);
	if (full) section("Full System Prompt", ["", "  " + "─".repeat(42), ...prompt.split("\n").map((line) => `  ${line}`), "  " + "─".repeat(42)]);
	lines.push(theme.fg("dim", "  ─".repeat(40)), "");
	return lines;
}

export default function info(pi: ExtensionAPI) {
	pi.registerCommand("info", {
		description: "Show session info: tools, skills, prompts, context files",
		handler: async (_args, ctx) => {
			await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
				let full = false;
				let width = 0;
				let offset = 0;
				let lines: string[] = [];
				const scroll = (to: number) => {
					offset = Math.max(0, Math.min(to, lines.length - 1));
					tui.requestRender();
				};
				return {
					render(newWidth: number) {
						if (newWidth !== width) {
							width = newWidth;
							lines = infoLines(pi, ctx, theme, full).flatMap((line) => {
								const wrapped = wrapTextWithAnsi(line, width);
								return wrapped.length ? wrapped : [""];
							});
							offset = Math.min(offset, lines.length - 1);
						}
						const end = Math.min(offset + PAGE, lines.length);
						const where = offset === 0 ? "▲ top" : end >= lines.length ? "▼ bottom" : `${offset + 1}–${end} / ${lines.length}`;
						const page = lines.slice(offset, end);
						return [
							truncateToWidth(theme.fg("dim", `  ${where} ${"─".repeat(Math.max(1, width - where.length - 5))}`), width),
							...page,
							...Array<string>(PAGE - page.length).fill(""),
							truncateToWidth(theme.fg("dim", HELP), width),
						];
					},
					invalidate() {
						width = 0;
					},
					handleInput(data: string) {
						if (data === "f" || data === "F" || matchesKey(data, Key.tab)) {
							full = !full;
							width = 0;
							tui.requestRender();
						} else if (data === "q" || data === "Q" || matchesKey(data, Key.escape)) done();
						else if (matchesKey(data, Key.up)) scroll(offset - 1);
						else if (matchesKey(data, Key.down)) scroll(offset + 1);
						else if (matchesKey(data, Key.pageUp)) scroll(offset - PAGE);
						else if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.space)) scroll(offset + PAGE);
						else if (matchesKey(data, Key.home)) scroll(0);
						else if (matchesKey(data, Key.end)) scroll(lines.length - 1);
					},
				};
			});
		},
	});
}
