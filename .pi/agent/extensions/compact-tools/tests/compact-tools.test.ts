import assert from "node:assert/strict";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	ToolExecutionComponent, createReadToolDefinition, createBashToolDefinition,
	createEditToolDefinition, createWriteToolDefinition, getReadmePath, initTheme,
} from "@earendil-works/pi-coding-agent";
import { Text, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import compactTools from "../index.js";
import { SETTINGS_ENTRY, TIMINGS_ENTRY, ToolStore } from "../model.js";
import { describeRow, formatDuration, lineCount, singleLine } from "../format.js";
import { CacheNotices, hasThinkingDropNotice } from "../notices.js";

const hasCacheNotice = (entries: any[], message: any, price: () => number) => new CacheNotices(price).check(entries, message);
import { renderHeader } from "../render.js";

initTheme("dark");
// Obtain the live theme passed by Pi, rather than use a hand-written color mock.
let theme: any;
new ToolExecutionComponent("read", "theme", {}, {}, {
	renderCall(_args: unknown, current: any) { theme = current; return new Text(""); },
	renderResult() { return new Text(""); },
} as any, { requestRender() {} } as any, "/tmp");

const call = (id: string, name = "read", args: Record<string, unknown> = { path: `${id}.ts` }) => ({ type: "toolCall", id, name, arguments: args });
const assistant = (content: any[]) => ({ role: "assistant", content, stopReason: "toolUse" }) as any;
const result = (text = "file text", details: unknown = undefined) => ({ content: [{ type: "text", text }], details }) as any;
const plain = (lines: string[]) => lines.map((line) => stripTerminalSequences(line));
const definitions: Record<string, any> = {
	read: createReadToolDefinition("/tmp"), bash: createBashToolDefinition("/tmp"),
	edit: createEditToolDefinition("/tmp"), write: createWriteToolDefinition("/tmp"),
};

function harness(entries: any[] = [], mode = "tui", notices = false) {
	const handlers = new Map<string, any[]>();
	const commands = new Map<string, any>();
	let resolver: any;
	let reloads = 0;
	const appended: any[] = [];
	const pi: any = {
		on(name: string, fn: any) { handlers.set(name, [...handlers.get(name) ?? [], fn]); },
		registerToolRenderer(fn: any) { resolver = fn; },
		registerCommand(name: string, command: any) { commands.set(name, command); },
		getSettings() { return { showCacheMissNotices: notices }; },
		appendEntry(customType: string, data: unknown) { const entry = { type: "custom", customType, data }; entries.push(entry); appended.push(entry); },
	};
	const components = new Map<string, any>();
	let globalExpanded = false;
	const ctx: any = {
		mode, sessionManager: { getBranch: () => entries, getEntries: () => entries, buildContextEntries: () => entries },
		modelRegistry: { find: () => undefined },
		waitForIdle: async () => {}, reload: async () => { reloads++; },
		ui: { notify() {}, setToolsExpanded(expanded: boolean) { globalExpanded = expanded; for (const component of components.values()) component.setExpanded(expanded); } },
	};
	compactTools(pi);
	const emit = async (name: string, event: any = {}) => { for (const fn of handlers.get(name) ?? []) await fn(event, ctx); };
	const ready = emit("session_start");
	const add = (part: any, original = definitions[part.name]) => {
		const component = new ToolExecutionComponent(part.name, part.id, part.arguments, { showImages: false }, resolver(part.name, () => original), { requestRender() {} } as any, "/tmp");
		component.setExpanded(globalExpanded);
		components.set(part.id, component);
		return component;
	};
	const snapshot = (width = 100) => [...components.values()].flatMap((component) => component.render(width));
	const message = async (content: any[], fields: Record<string, unknown> = {}) => {
		const msg = { ...assistant(content), ...fields };
		await emit("message_start", { message: assistant([]) });
		await emit("message_update", { message: msg });
		for (const part of content) if (part.type === "toolCall") add(part);
		await emit("message_end", { message: msg });
		entries.push({ type: "message", message: msg });
		for (const component of components.values()) component.setArgsComplete();
	};
	const finish = async (id: string, value = result(), error = false) => {
		const component = components.get(id);
		await emit("tool_execution_end", { toolCallId: id, toolName: "read", result: value, isError: error });
		component.updateResult({ ...value, isError: error });
	};
	return { ready, emit, add, snapshot, message, finish, resolver: (name: string, next?: any) => resolver(name, () => next), ctx, commands, appended, components, reloads: () => reloads };
}

test("eight reads occupy nine lines, including one separator; no calls are folded", async () => {
	const h = harness(); await h.ready;
	await h.message(Array.from({ length: 8 }, (_, i) => call(`file-${i}`)));
	for (let i = 7; i >= 0; i--) await h.finish(`file-${i}`, result(`PRIVATE FILE CONTENT ${i}`));
	const lines = plain(h.snapshot());
	assert.equal(lines.length, 9);
	assert.equal(lines.filter((line) => !line.trim()).length, 1);
	for (let i = 0; i < 8; i++) assert.match(lines[i + 1], new RegExp(`file-${i}\\.ts`));
	assert.ok(!lines.join("\n").includes("PRIVATE FILE CONTENT"));
});

test("thirty calls stay visible, in order, with no phase-two folding", async () => {
	const h = harness(); await h.ready;
	await h.message(Array.from({ length: 30 }, (_, i) => call(`file-${i}`)));
	assert.equal(h.snapshot().length, 31);
});

test("call-only assistant messages join; visible text, thinking, and users separate groups", () => {
	const store = new ToolStore();
	const observe = (content: any[]) => { store.beginAssistant(); store.observeAssistant(assistant(content)); store.endAssistant(false); };
	observe([call("a")]); observe([call("b")]);
	assert.equal(store.rows.get("a")!.group, store.rows.get("b")!.group);
	observe([{ type: "text", text: "Explanation" }, call("c")]);
	assert.notEqual(store.rows.get("b")!.group, store.rows.get("c")!.group);
	observe([{ type: "thinking", thinking: "Reasoning" }, call("d")]);
	assert.notEqual(store.rows.get("c")!.group, store.rows.get("d")!.group);
	store.breakGroup(); observe([call("e")]);
	assert.notEqual(store.rows.get("d")!.group, store.rows.get("e")!.group);
});

test("late streamed text splits a tentative continuation without moving earlier calls", () => {
	const store = new ToolStore();
	store.beginAssistant(); store.observeAssistant(assistant([call("a")])); store.endAssistant(false);
	store.beginAssistant(); store.observeAssistant(assistant([call("b")]));
	assert.equal(store.rows.get("a")!.group, store.rows.get("b")!.group);
	store.observeAssistant(assistant([{ type: "text", text: "Late text" }, call("b")]));
	assert.deepEqual(store.rows.get("a")!.group.rows.map((row) => row.id), ["a"]);
	assert.deepEqual(store.rows.get("b")!.group.rows.map((row) => row.id), ["b"]);
});

test("interactive/custom tools are not overridden and separate neighboring groups", async () => {
	const h = harness(); await h.ready;
	const native = { renderCall: () => new Text("questionnaire") };
	assert.equal(h.resolver("questionnaire", native), native);
	const store = new ToolStore();
	store.beginAssistant(); store.observeAssistant(assistant([call("a"), call("q", "questionnaire", {}), call("b")]));
	assert.notEqual(store.rows.get("a")!.group, store.rows.get("b")!.group);
});

test("native image calls remain standalone, including images discovered only in the result", () => {
	const store = new ToolStore();
	store.beginAssistant(); store.observeAssistant(assistant([call("a"), call("image"), call("b")]));
	store.setResult(store.rows.get("image")!, { content: [{ type: "image", data: "AA==", mimeType: "image/png" }], details: undefined }, false, false);
	for (const id of ["a", "image", "b"]) assert.deepEqual(store.rows.get(id)!.group.rows.map((row) => row.id), [id]);
	store.clear(); store.beginAssistant();
	store.observeAssistant(assistant([call("a"), call("image", "read", { path: "photo.png" }), call("b")]));
	for (const id of ["a", "image", "b"]) assert.deepEqual(store.rows.get(id)!.group.rows.map((row) => row.id), [id]);
});

test("clicking the second grouped row expands that row, not the anchor", async () => {
	const h = harness(); await h.ready;
	await h.message([call("a"), call("b")]);
	await h.finish("a", result("FIRST SECRET")); await h.finish("b", result("SECOND SECRET"));
	h.snapshot();
	const handled = h.components.get("a").handleMouse({ type: "click", button: "left", x: 5, y: 2, screenX: 5, screenY: 2, width: 100, height: 3, shift: false, alt: false, ctrl: false });
	assert.ok(handled?.handled);
	const text = plain(h.snapshot()).join("\n");
	assert.ok(text.includes("SECOND SECRET"));
	assert.ok(!text.includes("FIRST SECRET"));
	await h.commands.get("compact-tools").handler("expand", h.ctx);
	assert.ok(plain(h.snapshot()).join("\n").includes("FIRST SECRET"));
	await h.commands.get("compact-tools").handler("collapse", h.ctx);
	assert.equal(h.snapshot().length, 3);
});

test("full commands, writes, and diffs remain available only after expansion", async () => {
	const h = harness(); await h.ready;
	const code = Array.from({ length: 90 }, (_, i) => `echo UNIQUE_COMMAND_${i}`).join("\n");
	const written = Array.from({ length: 90 }, (_, i) => `UNIQUE_FILE_LINE_${i}`).join("\n");
	await h.message([call("bash", "bash", { command: code }), call("write", "write", { path: "file.txt", content: written }), call("edit", "edit", { path: "file.txt", edits: [{ oldText: "old", newText: "new" }] })]);
	await h.finish("bash", result("OUTPUT_BEGIN\nOUTPUT_END"));
	await h.finish("write", result("Written"));
	await h.finish("edit", result("Edited", { diff: "-1 OLD_DIFF_LINE\n+1 NEW_DIFF_LINE" }));
	assert.equal(h.snapshot().length, 4);
	const collapsed = plain(h.snapshot()).join("\n");
	assert.ok(!collapsed.includes("UNIQUE_COMMAND_89"));
	assert.ok(!collapsed.includes("UNIQUE_FILE_LINE_0"));
	assert.ok(!collapsed.includes("NEW_DIFF_LINE"));
	await h.commands.get("compact-tools").handler("expand", h.ctx);
	const expanded = plain(h.snapshot()).join("\n");
	for (const text of ["UNIQUE_COMMAND_89", "UNIQUE_FILE_LINE_89", "OLD_DIFF_LINE", "NEW_DIFF_LINE", "OUTPUT_END"]) assert.ok(expanded.includes(text), text);
});

test("errors are one red row with a reason, while full error output can be expanded", async () => {
	const h = harness(); await h.ready;
	await h.message([call("error")]);
	await h.finish("error", result("FIRST_ERROR_DETAIL\nENOENT: file not found"), true);
	const collapsed = h.snapshot();
	assert.equal(collapsed.length, 2);
	assert.match(plain(collapsed).join("\n"), /✗.*ENOENT/);
	const errorBackground = theme.bg("toolErrorBg", "x").match(/\x1b\[48;[\d;]+m/)?.[0];
	assert.ok(errorBackground && collapsed[1].includes(errorBackground));
	await h.commands.get("compact-tools").handler("expand", h.ctx);
	assert.ok(plain(h.snapshot()).join("\n").includes("FIRST_ERROR_DETAIL"));
});

test("compact rows fit narrow widths, Unicode paths, and long scripts without wrapping", async () => {
	const h = harness(); await h.ready;
	await h.message([call("unicode", "read", { path: "/tmp/very/long/目录/áé/archivo.ts", offset: null, limit: null }), call("script", "bash", { command: "echo " + "界".repeat(1000) })]);
	for (const width of [1, 8, 20, 40, 80, 160]) {
		const lines = h.snapshot(width);
		assert.equal(lines.length, 3);
		for (const line of lines) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`);
	}
});

test("pending calls, streamed output, completion, and theme changes update the shared anchor", async () => {
	const h = harness(); await h.ready;
	await h.message([call("a"), call("b")]);
	assert.match(plain(h.snapshot()).join("\n"), /….*b\.ts/);
	await h.emit("tool_execution_start", { toolCallId: "b", toolName: "read", args: { path: "b.ts" } });
	h.components.get("b").markExecutionStarted();
	h.components.get("b").updateResult({ ...result("STREAMED_PREVIEW_MUST_STAY_HIDDEN"), isError: false }, true);
	let lines = plain(h.snapshot());
	assert.match(lines[2], /◌.*b\.ts/);
	assert.ok(!/\d+(?:ms|s)\s*$/.test(lines[2]));
	assert.ok(!lines.join("\n").includes("STREAMED_PREVIEW"));
	await h.finish("b");
	assert.match(plain(h.snapshot())[2], /✓.*b\.ts/);
	try {
		initTheme("light");
		for (const component of h.components.values()) component.invalidate();
		const successBackground = theme.bg("toolSuccessBg", "x").match(/\x1b\[48;[\d;]+m/)?.[0];
		assert.ok(successBackground && h.snapshot()[2].includes(successBackground));
	} finally {
		initTheme("dark");
		await h.emit("session_shutdown");
	}
});

test("MCP tools get compact rows and retain complete generic arguments and results", async () => {
	const h = harness(); await h.ready;
	await h.message([call("mcp", "mcp__docs__search", { query: "documentation", extra: "FULL_ARGUMENT" })]);
	await h.finish("mcp", result("FULL_MCP_RESULT"));
	assert.equal(h.snapshot().length, 2);
	assert.ok(!plain(h.snapshot()).join("\n").includes("FULL_MCP_RESULT"));
	await h.commands.get("compact-tools").handler("expand", h.ctx);
	const expanded = plain(h.snapshot()).join("\n");
	assert.ok(expanded.includes("FULL_ARGUMENT"));
	assert.ok(expanded.includes("FULL_MCP_RESULT"));
});

test("history restores shell durations, omits old read timings, and invents no timings", async () => {
	const message = assistant([call("a", "bash", { command: "echo a" }), call("b", "bash", { command: "echo b" }), call("read")]);
	const entries = [
		{ type: "message", message },
		...message.content.map((part: any) => ({ type: "message", message: { role: "toolResult", toolCallId: part.id, toolName: part.name, ...result(), isError: false } })),
		{ type: "custom", customType: TIMINGS_ENTRY, data: { durations: { a: 1234, read: 9999 } } },
	];
	const h = harness(entries); await h.ready;
	for (const part of message.content) { const component = h.add(part); component.updateResult({ ...result(), isError: false }); }
	const lines = plain(h.snapshot());
	assert.equal(lines.length, 4);
	assert.match(lines[1], /1\.2s/);
	assert.ok(!/\d+(?:ms|s)\s*$/.test(lines[2]));
	assert.ok(!/\d+(?:ms|s)\s*$/.test(lines[3]));
});

test("only timed tools persist timings outside model context; nested calls create no extra rows", async () => {
	const h = harness(); await h.ready;
	const parts = [call("a", "bash", { command: "echo a" }), call("read"), call("edit", "edit", { path: "a.ts" }), call("write", "write", { path: "b.ts", content: "b" })];
	await h.message(parts);
	for (const part of parts) {
		await h.emit("tool_execution_start", { toolCallId: part.id, toolName: part.name, args: part.arguments });
		h.components.get(part.id).markExecutionStarted();
	}
	await h.emit("tool_execution_start", { toolCallId: "a/1", toolName: "read", args: { path: "nested.ts" }, parentToolCallId: "a" });
	assert.match(plain(h.snapshot(40))[1], /◌.*\d+ms/);
	for (const part of parts) await h.finish(part.id);
	await h.emit("turn_end");
	assert.equal(h.appended.length, 1);
	assert.equal(h.appended[0].customType, TIMINGS_ENTRY);
	assert.deepEqual(Object.keys(h.appended[0].data.durations), ["a"]);
	assert.ok(h.appended[0].data.durations.a >= 0);
	assert.equal(h.snapshot().length, 5);
	await h.emit("session_shutdown");
});

test("eight separate turns still form one block when notices are enabled but none are visible", async () => {
	const h = harness([], "tui", true); await h.ready;
	for (let i = 0; i < 8; i++) {
		await h.message([call(`sequential-${i}`)]);
		await h.finish(`sequential-${i}`);
		await h.emit("turn_end");
	}
	const lines = plain(h.snapshot());
	assert.equal(lines.length, 9);
	assert.equal(lines.filter((line) => !line.trim()).length, 1);
	for (let i = 0; i < 8; i++) assert.ok(lines[i + 1].includes(`sequential-${i}.ts`));
});

const usage = (input: number, cacheRead = 0, inputCost = 0) => ({
	input, output: 0, cacheRead, cacheWrite: 0, totalTokens: input + cacheRead,
	cost: { input: inputCost, output: 0, cacheRead: 0, cacheWrite: 0, total: inputCost },
});

test("real cache notices separate blocks only after the message that produced the notice", async () => {
	const h = harness([], "tui", true); await h.ready;
	await h.message([call("a")], { usage: usage(0, 30_000) });
	await h.message([call("b")], { usage: usage(30_000, 0, 0.3) });
	await h.message([call("c")], { usage: usage(0, 30_000) });
	const lines = plain(h.snapshot());
	assert.equal(lines.length, 5);
	assert.match(lines[1], /a\.ts/);
	assert.match(lines[2], /b\.ts/);
	assert.equal(lines[3], "");
	assert.match(lines[4], /c\.ts/);
});

test("reload preserves grouping across distinct assistant messages, timings, and invisible usage entries", async () => {
	const messages = ["a", "b", "c"].map((id) => assistant([call(id)]));
	const entries: any[] = [
		{ type: "message", message: messages[0] },
		{ type: "custom", customType: TIMINGS_ENTRY, data: { durations: { a: 12 } } },
		{ type: "usage", kind: "other", usage: usage(0) },
		{ type: "message", message: messages[1] },
		{ type: "message", message: messages[2] },
	];
	const h = harness(entries, "tui", true); await h.ready;
	for (const msg of messages) for (const part of msg.content) h.add(part).updateResult({ ...result(), isError: false });
	assert.equal(h.snapshot().length, 4);
});

test("reload respects actual cache notices but joins messages with only small cache misses", async () => {
	for (const [tokens, cost, expectedLines] of [[30_000, 0.3, 5], [5000, 0.01, 4]]) {
		const messages = [
			{ ...assistant([call("a")]), usage: usage(0, tokens) },
			{ ...assistant([call("b")]), usage: usage(tokens, 0, cost) },
			{ ...assistant([call("c")]), usage: usage(0, tokens) },
		];
		const h = harness(messages.map((message) => ({ type: "message", message })), "tui", true); await h.ready;
		for (const msg of messages) for (const part of msg.content) h.add(part).updateResult({ ...result(), isError: false });
		assert.equal(h.snapshot().length, expectedLines);
	}
});

test("notice detection matches significance thresholds, cache support, warming, and context resets", () => {
	const cached = { ...assistant([]), usage: usage(0, 30_000), provider: "test", model: "test" };
	const prior: any[] = [{ type: "message", message: cached }];
	const current = (tokens: number, cost: number) => ({ ...assistant([]), usage: usage(tokens, 0, cost), provider: "test", model: "test" });
	assert.equal(hasCacheNotice(prior, current(20_000, 0), () => 0), true);
	assert.equal(hasCacheNotice(prior, current(19_999, 0), () => 0), false);
	assert.equal(hasCacheNotice(prior, current(5000, 0.1), () => 0), true);
	assert.equal(hasCacheNotice(prior, current(5000, 0.099), () => 0), false);
	assert.equal(hasCacheNotice(prior, current(5000, 0.1), () => 20), false);
	assert.equal(hasCacheNotice([], current(30_000, 0.3), () => 0), false);
	assert.equal(hasCacheNotice([{ type: "message", message: current(30_000, 0.3) }] as any, current(30_000, 0.3), () => 0), false);
	assert.equal(hasCacheNotice([...prior, { type: "compaction" }] as any, current(30_000, 0.3), () => 0), false);
	assert.equal(hasCacheNotice([{ type: "usage", kind: "cache_warm", usage: usage(30_000) }] as any, current(30_000, 0.3), () => 0), true);
	const miss = current(30_000, 0.3);
	assert.ok(new CacheNotices(() => 0).catchUp([...prior, { type: "message", message: miss }] as any).has(miss));
	const scanner = new CacheNotices(() => 0);
	assert.equal(scanner.check(prior, miss), true);
	assert.equal(scanner.catchUp([...prior, { type: "message", message: miss }] as any).size, 0, "a checked message is not counted again once persisted");
});

test("asynchronous cache-warming entries separate tools only when their notice is visible", async () => {
	for (const notices of [false, true]) {
		const h = harness([], "tui", notices); await h.ready;
		await h.message([call("a")]);
		h.ctx.sessionManager.getBranch().push({ type: "usage", kind: "cache_warm", usage: usage(30_000) });
		await h.message([call("b")]);
		assert.equal(h.snapshot().length, notices ? 4 : 3);
	}
});

test("thinking-drop notices only separate blocks when the dropped count increases", async () => {
	const dropped = (count: number) => [{ type: "anthropic_input_transformations", details: { transformations: Array.from({ length: count }, () => ({ type: "thinking_dropped" })) } }];
	const first = { ...assistant([]), diagnostics: dropped(1) };
	assert.equal(hasThinkingDropNotice([], first), true);
	assert.equal(hasThinkingDropNotice([{ type: "message", message: first }] as any, { ...assistant([]), diagnostics: dropped(1) }), false);
	const h = harness([], "tui", true); await h.ready;
	await h.message([call("a")], { diagnostics: dropped(1) });
	await h.message([call("b")], { diagnostics: dropped(1) });
	await h.message([call("c")], { diagnostics: dropped(1) });
	assert.equal(h.snapshot().length, 5);
});

test("empty assistant messages and whitespace do not separate tools, but truncation text does", async () => {
	const h = harness([], "tui", true); await h.ready;
	await h.message([call("a")]);
	await h.message([]);
	await h.message([{ type: "text", text: " \n " }, { type: "thinking", thinking: " " }]);
	await h.message([call("b")]);
	assert.equal(h.snapshot().length, 3);
	await h.message([call("c")], { stopReason: "length" });
	assert.equal(h.snapshot().length, 5);
});

test("non-TUI modes and disabled sessions use the original renderers unchanged", async () => {
	for (const mode of ["print", "json", "rpc"]) {
		const h = harness([], mode); await h.ready;
		assert.equal(h.resolver("read", definitions.read), definitions.read);
	}
	const h = harness([{ type: "custom", customType: SETTINGS_ENTRY, data: { enabled: false } }]); await h.ready;
	assert.equal(h.resolver("read", definitions.read), definitions.read);
	await h.commands.get("compact-tools").handler("on", h.ctx);
	assert.equal(h.reloads(), 1);
	assert.deepEqual(h.appended.at(-1).data, { enabled: true });
});

test("clock, line counting, error sanitization, and row statistics", () => {
	assert.equal(formatDuration(123), "123ms");
	assert.equal(formatDuration(1250), "1.3s");
	assert.equal(formatDuration(65_000), "1m5s");
	assert.equal(lineCount("a\nb\n"), 2);
	assert.equal(lineCount(""), 0);
	assert.equal(singleLine("\x1b[31mred\x1b[0m\ntext"), "red text");
	const store = new ToolStore();
	const row = store.ensure("edit", "edit", { path: "file.txt" });
	store.setResult(row, result("OK", { diff: "+1 foo\n+2 bar\n-1 baz" }), false, false);
	assert.equal(describeRow(row).metadata, "+2 -1");
	const scripted = store.ensure("script", "codemode", { code: "one\ntwo" });
	store.setResult(scripted, result("OK", { calls: [{ status: "ok" }, { status: "error" }] }), false, false);
	assert.equal(describeRow(scripted).warning, true);
	assert.equal(describeRow(scripted).primary, "s:2");
	assert.equal(describeRow(scripted).metadata, "c:2 e:1 o:1");
});

test("mobile headers use compact English metadata and clocks only for shells and codemode", () => {
	const store = new ToolStore();
	const examples: [string, Record<string, unknown>, any, number, string][] = [
		["read", { path: "a.ts" }, result(), 1000, "✓ read a.ts"],
		["write", { path: "test.py", content: "x\n".repeat(86) }, result("Written"), 1000, "✓ write test.py 86L"],
		["edit", { path: "asr.py" }, result("Edited", { diff: "+x\n".repeat(12) + "-x\n".repeat(4) }), 1000, "✓ edit asr.py +12 -4"],
		["bash", { command: "pytest" }, result("ok\n".repeat(34)), 1800, "✓ bash pytest o:34 1.8s"],
		["bash", { command: "python script.py\n" + "# comment\n".repeat(93) }, result("a\nb\nc"), 2100, "✓ bash python script.py s:94 o:3 2.1s"],
		["codemode", { code: "one\n".repeat(94) }, result("Script completed\nWall time 4.2 seconds\nOutput:\n", { calls: Array.from({ length: 8 }, () => ({ status: "ok" })) }), 4200, "✓ codemode s:94 c:8 4.2s"],
		["codemode", { code: "console.log(1)" }, result(""), 123, "✓ codemode 123ms"],
		["mcp__docs__search", { query: "docs" }, result(), 1000, "✓ mcp__docs__search docs"],
	];
	for (const [name, args, value, duration, expected] of examples) {
		const row = store.ensure(name, name, args);
		store.setResult(row, value, false, false);
		row.durationMs = duration;
		assert.equal(stripTerminalSequences(renderHeader(row, store, theme, 40)).trimEnd(), expected);
	}
});

test("output counts exclude native headers, no-output placeholders, and truncation footers", () => {
	const store = new ToolStore();
	const bash = store.ensure("bash", "bash", { command: "echo a" });
	store.setResult(bash, result("(no output)"), false, false);
	assert.equal(describeRow(bash).metadata, "");
	store.setResult(bash, { ...result("a\nb\n"), structuredContent: { output: "a\nb\n" } }, false, false);
	assert.equal(describeRow(bash).metadata, "o:2");
	store.setResult(bash, result("tail\n\n[Showing lines 99-100 of 100. Full output: /tmp/output]", { truncation: { truncated: true, totalLines: 100 }, fullOutputPath: "/tmp/output" }), false, false);
	assert.equal(describeRow(bash).metadata, "o:100 trunc");
	store.setResult(bash, { ...result("a\n\n[Showing output. Full output: /tmp/output]", { fullOutputPath: "/tmp/output" }), structuredContent: undefined }, false, false);
	assert.equal(describeRow(bash).metadata, "o:1 trunc");
	store.setResult(bash, result("a\n\nCommand exited with code 1"), false, true);
	assert.equal(describeRow(bash).metadata, "exit:1");
	const code = store.ensure("code", "codemode", { code: "console.log(1)" });
	store.setResult(code, { content: [{ type: "text", text: "Script completed\nWall time 1.2 seconds\nOutput:\n" }, { type: "text", text: "a\nb\n" }], details: { calls: [{ status: "ok" }] } }, false, false);
	assert.equal(describeRow(code).primary, "");
	assert.equal(describeRow(code).metadata, "c:1 o:2");
});

test("special read labels match Pi: skills, instruction resources, and Pi docs", async () => {
	const root = dirname(getReadmePath());
	const paths: [string, string][] = [
		["skills/frontend-design/SKILL.md", "[skill]"],
		["@skills/zig-knowledge/SKILL.md", "[skill]"],
		["~/skills/special/SKILL.md", "[skill]"],
		["AGENTS.md", "read resource"],
		["sub/AGENTS.override.md", "read resource"],
		["AGENTS.MD", "read resource"],
		["CLAUDE.md", "read resource"],
		["CLAUDE.MD", "read resource"],
		[getReadmePath(), "read docs"],
		[join(root, "docs", "extensions.md"), "read docs"],
		[pathToFileURL(join(root, "docs", "tui.md")).href, "read docs"],
		[join(root, "examples", "extensions", "hello.ts"), "read docs"],
	];
	const h = harness(); await h.ready;
	await h.message(paths.map(([path], i) => call(`special-${i}`, "read", { path })));
	for (let i = 0; i < paths.length; i++) await h.finish(`special-${i}`, result("PRIVATE_READ_CONTENT"));
	for (const width of [40, 80, 160]) {
		const lines = h.snapshot(width);
		assert.equal(lines.length, paths.length + 1);
		for (let i = 0; i < paths.length; i++) {
			const [path, badge] = paths[i];
			const native = new ToolExecutionComponent("read", "native", { path }, { showImages: false }, definitions.read, { requestRender() {} } as any, "/tmp");
			assert.ok(plain(native.render(500)).join("\n").includes(badge), path);
			assert.ok(stripTerminalSequences(lines[i + 1]).includes(badge), path);
			assert.ok(visibleWidth(lines[i + 1]) <= width);
			assert.ok(!stripTerminalSequences(lines[i + 1]).includes("to expand"));
		}
		const skillTitle = width < 80 ? "[skill]" : "[skill]".padEnd("read resource".length);
		assert.ok(lines[1].includes(theme.fg("customMessageLabel", theme.bold(skillTitle))));
		assert.ok(lines[1].includes(theme.fg("customMessageText", "frontend-design")));
	}
	const collapsed = plain(h.snapshot()).join("\n");
	assert.ok(!collapsed.includes("PRIVATE_READ_CONTENT"));
	await h.commands.get("compact-tools").handler("expand", h.ctx);
	assert.ok(plain(h.snapshot()).join("\n").includes("PRIVATE_READ_CONTENT"));
	await h.commands.get("compact-tools").handler("collapse", h.ctx);
	assert.equal(h.snapshot().length, paths.length + 1);
});

test("ordinary reads are not falsely marked as skills, resources, or Pi documentation", async () => {
	const paths = ["README.md", "agents.md", "skills/ordinary/skill.md", `${dirname(getReadmePath())}-outside/docs/extensions.md`];
	const h = harness(); await h.ready;
	await h.message(paths.map((path, i) => call(`ordinary-${i}`, "read", { path })));
	const text = plain(h.snapshot(40)).join("\n");
	assert.ok(!/\[skill\]|read resource|read docs/.test(text));
});

test("narrow layout changes at 80 columns without changing expansion or row count", async () => {
	const h = harness(); await h.ready;
	await h.message([call("a"), call("b")]);
	await h.finish("a", result("FIRST_SECRET")); await h.finish("b", result("SECOND_SECRET"));
	for (const width of [1, 8, 20, 40, 79, 80, 100, 160]) {
		const lines = plain(h.snapshot(width));
		assert.equal(lines.length, 3);
		for (const line of lines) assert.ok(visibleWidth(line) <= width);
		if (width >= 20 && width < 80) assert.equal(lines[1].trimEnd(), "✓ read a.ts");
		if (width >= 80) assert.match(lines[1], /▸/);
	}
	h.snapshot(40);
	assert.ok(h.components.get("a").handleMouse({ type: "click", button: "left", x: 5, y: 2, screenX: 5, screenY: 2, width: 40, height: 3, shift: false, alt: false, ctrl: false })?.handled);
	const expanded = plain(h.snapshot(40)).join("\n");
	assert.ok(expanded.includes("SECOND_SECRET"));
	assert.ok(!expanded.includes("FIRST_SECRET"));
	await h.commands.get("compact-tools").handler("expand", h.ctx);
	assert.ok(plain(h.snapshot(40)).join("\n").includes("FIRST_SECRET"));
	await h.commands.get("compact-tools").handler("collapse", h.ctx);
	assert.equal(h.snapshot(40).length, 3);
});

test("streaming deltas regroup only when grouping inputs change, and keep arguments current", () => {
	const store = new ToolStore();
	store.beginAssistant(); store.observeAssistant(assistant([call("a")])); store.endAssistant(false);
	store.beginAssistant();
	store.observeAssistant(assistant([call("b", "read", { path: "pho" })]));
	const a = store.rows.get("a")!, b = store.rows.get("b")!;
	assert.equal(b.group, a.group);
	store.observeAssistant(assistant([call("b", "read", { path: "photo.ts" })]));
	assert.equal(b.args.path, "photo.ts");
	assert.equal(b.group, a.group);
	store.observeAssistant(assistant([call("b", "read", { path: "photo.png" })]));
	assert.notEqual(b.group, a.group, "an image read leaves the text group");
	store.observeAssistant(assistant([{ type: "text", text: "  " }, call("b", "read", { path: "photo.png" })]));
	store.observeAssistant(assistant([{ type: "text", text: "Visible" }, call("b", "read", { path: "photo.png" })]));
	assert.equal(store.rows.get("b")!.group.rows.length, 1);
});
