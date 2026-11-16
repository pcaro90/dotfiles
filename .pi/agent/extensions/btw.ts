/**
 * /btw — side chat about the main session that reuses its prompt cache.
 *
 * Every main provider request is captured byte-for-byte in `before_provider_request`. A BTW
 * request replays that payload unchanged and only appends: the main turns finished after it,
 * the BTW thread so far and the new "[BTW]" question. The appended messages are converted on
 * their own, which matches converting the whole transcript. System prompt, tool declarations,
 * reasoning settings and session id stay identical, so the provider reuses the main cache (and,
 * on the next question, the previous BTW request). While the main run is busy, its in-flight
 * request is the prefix. Requests go over SSE so a Codex WebSocket continuation of the main
 * session is left alone. Tools stay declared but never run: a tool call gets an error result
 * and the model is asked again, at most MAX_ROUNDS times.
 *
 * `/btw` opens the side chat, `/btw <question>` asks right away. Esc closes it; with a thread
 * it offers to keep it, inject a summary into the main chat (summarized as one more cached BTW
 * turn) or discard it; `/btw inject` and `/btw reset` do the same without the overlay. The
 * thread is stored with `appendEntry`, outside the model context.
 * Needs one main request in this process first: after a restart or /reload there is nothing to
 * replay, and a request from a different model or another /tree branch cannot reuse the cache.
 *
 * BTW prompts: `/btw /<name> [args]` (also typed in the overlay) expands `<agentDir>/btw-prompts/<name>.md`,
 * which uses the prompt template format (frontmatter `description`/`argument-hint`, `$1`, `$@`,
 * `${@:N}`, `${1:-default}`…). Only that directory is read, so these side-question prompts never
 * become main-chat commands. It is re-read on every use: no /reload needed.
 *
 * Based on https://github.com/mitsuhiko/agent-stuff/blob/main/extensions/btw.ts
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { convertToLlm, getAgentDir, getMarkdownTheme, parseFrontmatter, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type SessionEntry, type Theme } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Message, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import { Container, Input, Key, Markdown, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type AutocompleteItem, type Focusable, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";

const ENTRY_TYPE = "btw-thread-entry";
const RESET_TYPE = "btw-thread-reset";
const FIRST_PREFIX = "[BTW] Side question from the user. BTW is a separate side channel: the main agent keeps working on its task independently, and these messages neither pause nor change it. Answer directly from the conversation so far. Do not call tools and do not continue the main task.\n\n";
const NEXT_PREFIX = "[BTW] ";
const BUSY_NOTE = "(The main agent is working on the latest request right now; its in-progress output is not visible here.)\n\n";
const SUMMARY_PROMPT = "[BTW] Summarize this side conversation for handoff into the main conversation. Keep key decisions, findings, risks and next actions. Output only the summary.";
const NO_TOOLS = "Tools are not available in BTW mode. Answer from the conversation so far, without calling tools.";
const MAX_ROUNDS = 3;
const CACHE_TTL_S = 300;
const KEEP = "Keep side thread";
const INJECT = "Inject summary into main chat";
const DISCARD = "Discard side thread";

type Payload = Record<string, unknown>;
type Captured = { payload: Payload; leafId: string | null; provider: string; modelId: string; at: number };
export type BtwTurn = { question: string; answer: string; messages: Message[]; usage: Usage; provider: string; model: string; timestamp: number };
type Pending = { question: string; answer: string; tools: string[]; error?: string };

/**
 * The transcript array of an OpenAI completions or Anthropic messages (`messages`) or an OpenAI
 * responses/Codex (`input`) payload. On Anthropic the splice keeps the main request's cache_control
 * breakpoint and adds one on the BTW message: four in all, the API maximum.
 */
export function itemsKey(payload: Payload): "messages" | "input" | undefined {
	return Array.isArray(payload.messages) ? "messages" : Array.isArray(payload.input) ? "input" : undefined;
}

/**
 * Messages finished after the captured request, up to the first assistant turn with tool calls
 * (its results would be missing or belong to a request that was never captured). Undefined when
 * the captured request is not on the current branch.
 */
export function tailMessages(branch: SessionEntry[], leafId: string | null): Message[] | undefined {
	const start = leafId === null ? 0 : branch.findIndex((entry) => entry.id === leafId) + 1;
	if (start === 0 && leafId !== null) return undefined;
	const tail: Message[] = [];
	for (const entry of branch.slice(start)) {
		if (entry.type !== "message") continue;
		const [message] = convertToLlm([entry.message]);
		if (!message) continue;
		if (message.role === "assistant" && message.content.some((part) => part.type === "toolCall")) break;
		tail.push(message);
	}
	return tail;
}

/** The captured payload with the new transcript items of `tailPayload` appended; nothing else changes. */
export function splicePayload(captured: Payload, tailPayload: Payload): Payload {
	const key = itemsKey(captured);
	const tailKey = itemsKey(tailPayload);
	if (!key || key !== tailKey) throw new Error("Payload shapes differ; cannot splice.");
	const added = (tailPayload[tailKey] as { role?: string }[]).filter((item) => item.role !== "system" && item.role !== "developer");
	const spliced: Payload = { ...structuredClone(captured), [key]: [...(captured[key] as unknown[]), ...added] };
	delete spliced.previous_response_id;
	return spliced;
}

export type BtwPrompt = { name: string; description: string; argumentHint?: string; content: string; path: string };

export function btwPromptsDir(): string {
	return join(getAgentDir(), "btw-prompts");
}

/** The `*.md` files directly in `dir` (symlinks followed), by name. A missing directory is empty. */
export function loadBtwPrompts(dir: string): Map<string, BtwPrompt> {
	const prompts = new Map<string, BtwPrompt>();
	let files: string[];
	try {
		files = readdirSync(dir).filter((file) => file.endsWith(".md")).sort();
	} catch {
		return prompts;
	}
	for (const file of files) {
		const path = join(dir, file);
		try {
			if (!statSync(path).isFile()) continue;
			const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(readFileSync(path, "utf8"));
			const firstLine = body.split("\n").find((line) => line.trim())?.trim() ?? "";
			const description = typeof frontmatter.description === "string" && frontmatter.description ? frontmatter.description : firstLine.slice(0, 60);
			const argumentHint = typeof frontmatter["argument-hint"] === "string" ? frontmatter["argument-hint"] : undefined;
			const name = basename(file, ".md");
			prompts.set(name, { name, description, argumentHint, content: body, path });
		} catch {
			// Unreadable or malformed file: skip it.
		}
	}
	return prompts;
}

/** Shell-like argument splitting, as pi does for prompt templates (`parseCommandArgs`, not exported). */
export function parseCommandArgs(argsString: string): string[] {
	const args: string[] = [];
	let current = "";
	let hasToken = false;
	let inQuote: string | null = null;
	let quoteStart = 0;
	for (let i = 0; i < argsString.length; i++) {
		const char = argsString[i]!;
		if (inQuote) {
			if (char === "\\" && argsString[i + 1] === inQuote) {
				current += inQuote;
				i++;
			} else if (char === inQuote) inQuote = null;
			else current += char;
		} else if ((char === '"' || char === "'") && !hasToken) {
			// Quotes only open an argument, so apostrophes inside words stay literal.
			inQuote = char;
			quoteStart = i;
			hasToken = true;
		} else if (/\s/.test(char)) {
			if (hasToken) {
				args.push(current);
				current = "";
				hasToken = false;
			}
		} else {
			current += char;
			hasToken = true;
		}
		if (inQuote && i === argsString.length - 1) {
			// Unclosed quote: keep it as text and parse the rest again.
			inQuote = null;
			current = argsString[quoteStart]!;
			i = quoteStart;
		}
	}
	if (hasToken) args.push(current);
	return args;
}

/** Prompt template placeholder substitution, as pi does it (`substituteArgs`, not exported). */
export function substituteArgs(content: string, args: string[]): string {
	const allArgs = args.join(" ");
	return content.replace(/\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g, (_match, defaultTarget, defaultValue, sliceStart, sliceLength, simple) => {
		if (defaultTarget) {
			const value = defaultTarget === "@" || defaultTarget === "ARGUMENTS" ? allArgs : args[parseInt(defaultTarget, 10) - 1];
			return value ? value : defaultValue;
		}
		if (sliceStart) {
			const start = Math.max(0, parseInt(sliceStart, 10) - 1);
			return (sliceLength ? args.slice(start, start + parseInt(sliceLength, 10)) : args.slice(start)).join(" ");
		}
		if (simple === "ARGUMENTS" || simple === "@") return allArgs;
		return args[parseInt(simple, 10) - 1] ?? "";
	});
}

/**
 * `/name [args]` → the expanded BTW prompt; anything else is a plain question. `/a/b…` (a path)
 * stays plain; an unknown `/name` is an error rather than a literal question.
 */
export function expandBtwInput(input: string, prompts: Map<string, BtwPrompt>): { text: string } | { error: string } {
	const match = input.match(/^\/([^\s/]+)(?:\s+([\s\S]*))?$/);
	if (!match) return { text: input };
	const prompt = prompts.get(match[1]!);
	if (!prompt) {
		const known = [...prompts.keys()].map((name) => `/${name}`).join(", ");
		return { error: `Unknown BTW prompt /${match[1]}. ${known ? `Available: ${known}` : `No prompts in ${btwPromptsDir()}`}.` };
	}
	const text = substituteArgs(prompt.content, parseCommandArgs(match[2] ?? "")).trim();
	return text ? { text } : { error: `BTW prompt /${prompt.name} is empty.` };
}

export function btwCompletions(prefix: string, prompts: Map<string, BtwPrompt>): AutocompleteItem[] | null {
	if (/\s/.test(prefix)) return null;
	const items: AutocompleteItem[] = [
		...[...prompts.values()].map((prompt) => ({
			value: `/${prompt.name} `,
			label: `/${prompt.name}`,
			description: [prompt.argumentHint, prompt.description].filter(Boolean).join(" — ") || undefined,
		})),
		{ value: "inject", label: "inject", description: "Summarize the side thread into the main chat" },
		{ value: "reset", label: "reset", description: "Discard the side thread" },
	];
	const filtered = items.filter((item) => item.label.startsWith(prefix));
	return filtered.length ? filtered : null;
}

function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function addUsage(total: Usage, usage: Usage): void {
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) total[key] += usage[key];
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) total.cost[key] += usage.cost[key];
}

export function formatUsage(usage: Usage): string {
	const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
	const rate = prompt ? ` (${Math.round((usage.cacheRead / prompt) * 100)}%)` : "";
	return `cached ${usage.cacheRead.toLocaleString()}/${prompt.toLocaleString()}${rate} · $${usage.cost.total.toFixed(4)}`;
}

function answerText(message: AssistantMessage): string {
	return message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim();
}

class BtwOverlay extends Container implements Focusable {
	private readonly input = new Input();
	private scroll = 0;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
		private readonly transcript: (width: number) => string[],
		private readonly status: () => string,
		onSubmit: (value: string) => void,
		private readonly onClose: () => void,
	) {
		super();
		this.input.onSubmit = (value) => {
			this.scroll = 0;
			onSubmit(value);
		};
		this.input.onEscape = onClose;
	}

	private get bodyHeight(): number {
		return Math.max(6, Math.min(30, Math.floor((process.stdout.rows ?? 30) * 0.75)) - 7);
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.cancel")) this.onClose();
		else if (matchesKey(data, Key.pageUp)) this.scroll += this.bodyHeight - 1;
		else if (matchesKey(data, Key.pageDown)) this.scroll = Math.max(0, this.scroll - this.bodyHeight + 1);
		else this.input.handleInput(data);
		this.tui.requestRender();
	}

	getDraft(): string {
		return this.input.getValue();
	}

	setDraft(value: string): void {
		this.input.setValue(value);
	}

	private frame(content: string, inner: number): string {
		const line = truncateToWidth(content, inner, "");
		const border = this.theme.fg("borderMuted", "│");
		return `${border}${line}${" ".repeat(Math.max(0, inner - visibleWidth(line)))}${border}`;
	}

	override render(width: number): string[] {
		const inner = Math.max(40, width - 2);
		const height = this.bodyHeight;
		const lines = this.transcript(inner);
		this.scroll = Math.min(this.scroll, Math.max(0, lines.length - height));
		const end = lines.length - this.scroll;
		const body = lines.slice(Math.max(0, end - height), end);
		const rule = (left: string, right: string) => this.theme.fg("borderMuted", `${left}${"─".repeat(inner)}${right}`);
		const more = this.scroll > 0 ? this.theme.fg("dim", ` ↓ ${this.scroll} more`) : "";
		const focused = this.input.focused;
		this.input.focused = false;
		const inputLine = this.input.render(inner)[0] ?? "";
		this.input.focused = focused;
		return [
			rule("┌", "┐"),
			this.frame(this.theme.fg("accent", this.theme.bold(" BTW side chat ")) + this.theme.fg("dim", "· reuses the main prompt cache · tools disabled"), inner),
			rule("├", "┤"),
			...body.map((line) => this.frame(line, inner)),
			...Array.from({ length: height - body.length }, () => this.frame("", inner)),
			rule("├", "┤"),
			this.frame(this.theme.fg("warning", this.status()) + more, inner),
			`${this.theme.fg("borderMuted", "│")}${inputLine}${this.theme.fg("borderMuted", "│")}`,
			this.frame(this.theme.fg("dim", "Enter ask · PgUp/PgDn scroll · Esc close"), inner),
			rule("└", "┘"),
		];
	}
}

export default function btw(pi: ExtensionAPI) {
	let captured: Captured | undefined;
	let capturedJson = "";
	let thread: BtwTurn[] = [];
	let pending: Pending | undefined;
	let status = "Ready";
	let abort: AbortController | undefined;
	let draft = "";
	let overlay: { refresh(): void; close(): void } | undefined;
	let refreshTimer: ReturnType<typeof setTimeout> | undefined;
	const mdTheme = getMarkdownTheme();

	const refresh = (throttled = false) => {
		if (!throttled) return overlay?.refresh();
		refreshTimer ??= setTimeout(() => {
			refreshTimer = undefined;
			overlay?.refresh();
		}, 16);
	};
	const setStatus = (text: string) => {
		status = text;
		refresh();
	};
	const notify = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error") => {
		if (ctx.hasUI) ctx.ui.notify(message, level);
		else if (level !== "info") console.error(message);
	};

	pi.on("before_provider_request", (event, ctx) => {
		const payload = event.payload as Payload;
		if (!ctx.model || !payload || typeof payload !== "object" || !itemsKey(payload)) return;
		const json = JSON.stringify(payload);
		// A cache-warming refresh resends the same request later: keep the leaf it was built from.
		if (captured && json === capturedJson) {
			captured.at = Date.now();
			return;
		}
		capturedJson = json;
		captured = { payload: structuredClone(payload), leafId: ctx.sessionManager.getLeafId(), provider: ctx.model.provider, modelId: ctx.model.id, at: Date.now() };
	});

	function markdown(text: string, width: number): string[] {
		try {
			return new Markdown(text, 0, 0, mdTheme).render(width);
		} catch {
			return text.split("\n").flatMap((line) => wrapTextWithAnsi(line, width));
		}
	}

	function transcript(width: number, theme: Theme): string[] {
		if (!thread.length && !pending) return [theme.fg("dim", "No BTW messages yet. Ask about the main session below; the main agent keeps working.")];
		const you = (question: string) => wrapTextWithAnsi(theme.fg("accent", theme.bold("You: ")) + question.trim(), width);
		const lines: string[] = [];
		for (const turn of thread) lines.push(...you(turn.question), "", ...markdown(turn.answer, width), "");
		if (pending) {
			lines.push(...you(pending.question));
			if (pending.tools.length) lines.push(theme.fg("warning", `  Tried to call ${pending.tools.join(", ")}; not run in BTW.`));
			if (pending.error) lines.push(theme.fg("error", `❌ ${pending.error}`));
			else if (pending.answer) lines.push("", ...markdown(pending.answer, width));
			else lines.push(theme.fg("dim", "…"));
		}
		while (lines.at(-1) === "") lines.pop();
		return lines;
	}

	/** Ask one BTW question (or the handoff summary) on top of the captured main request. */
	async function ask(ctx: ExtensionContext, text: string, signal: AbortSignal): Promise<{ messages: Message[]; answer: string; usage: Usage }> {
		const model = ctx.model;
		if (!model) throw new Error("No active model.");
		const base = captured;
		if (!base) throw new Error("Nothing to replay yet: send a message in the main chat first (needed after a restart or /reload).");
		if (base.provider !== model.provider || base.modelId !== model.id) throw new Error(`The last main request used ${base.provider}/${base.modelId}; ${model.provider}/${model.id} cannot reuse its cache. Send a main message first.`);
		// While the main run is busy, its in-flight request is exactly the cached prefix.
		const tail = ctx.isIdle() ? tailMessages(ctx.sessionManager.getBranch(), base.leafId) : [];
		if (!tail) throw new Error("The last main request is on another branch (after /tree). Send a main message first.");
		const history = [...tail, ...thread.flatMap((turn) => turn.messages)];
		const messages: Message[] = [{ role: "user", content: text, timestamp: Date.now() }];
		const usage = emptyUsage();
		const level = pi.getThinkingLevel();
		for (let round = 1; ; round++) {
			const stream = ctx.modelRegistry.streamSimple(model, { messages: [...history, ...messages] }, {
				sessionId: ctx.sessionManager.getSessionId(),
				reasoning: level === "off" ? undefined : (level as never),
				transport: "sse",
				signal,
				onPayload: (payload) => splicePayload(base.payload, payload as Payload),
			});
			for await (const event of stream) {
				if (pending && "partial" in event && event.partial) {
					pending.answer = answerText(event.partial);
					refresh(true);
				}
			}
			const response = await stream.result();
			addUsage(usage, response.usage);
			if (response.stopReason === "error" || response.stopReason === "aborted") throw new Error(response.errorMessage || `BTW request ${response.stopReason}.`);
			messages.push(response);
			const calls = response.content.filter((part) => part.type === "toolCall");
			if (!calls.length) return { messages, answer: answerText(response) || "(no text response)", usage };
			pending?.tools.push(...calls.map((call) => call.name));
			if (round === MAX_ROUNDS) return { messages: messages.slice(0, -1), answer: answerText(response) || "(the model kept calling tools; no answer)", usage };
			for (const call of calls) {
				const result: ToolResultMessage = { role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: NO_TOOLS }], isError: true, timestamp: Date.now() };
				messages.push(result);
			}
		}
	}

	function cacheWarning(): string {
		const age = captured ? Math.round((Date.now() - captured.at) / 1000) : 0;
		return age > CACHE_TTL_S ? ` · main request ${Math.round(age / 60)} min old: the cache may have expired` : "";
	}

	/** `question` is what the user typed (shown in the thread); `prompt` is what the model gets (a BTW prompt expanded). */
	async function runQuestion(ctx: ExtensionContext, question: string, prompt: string): Promise<void> {
		if (pending && !pending.error) return notify(ctx, "BTW is still answering the previous question.", "warning");
		pending = { question, answer: "", tools: [] };
		abort = new AbortController();
		setStatus(`Asking ${ctx.model?.id ?? ""}…${cacheWarning()}`);
		try {
			const text = (thread.length ? NEXT_PREFIX : FIRST_PREFIX) + (ctx.isIdle() ? "" : BUSY_NOTE) + prompt;
			const result = await ask(ctx, text, abort.signal);
			const turn: BtwTurn = { question, ...result, provider: ctx.model!.provider, model: ctx.model!.id, timestamp: Date.now() };
			thread.push(turn);
			pi.appendEntry(ENTRY_TYPE, turn);
			pending = undefined;
			setStatus(`Ready · ${formatUsage(turn.usage)}`);
			if (!overlay && !ctx.hasUI) console.log(turn.answer);
			else if (!overlay) notify(ctx, ctx.mode === "tui" ? "BTW answered; /btw to read it." : `BTW: ${turn.answer}`, "info");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (pending) pending.error = message;
			setStatus("BTW request failed.");
			if (!overlay) notify(ctx, `BTW: ${message}`, "error");
		} finally {
			abort = undefined;
			refresh();
		}
	}

	function resetThread(persist: boolean): void {
		abort?.abort();
		thread = [];
		pending = undefined;
		draft = "";
		status = "Ready";
		if (persist) pi.appendEntry(RESET_TYPE, { timestamp: Date.now() });
		refresh();
	}

	async function injectSummary(ctx: ExtensionContext): Promise<void> {
		if (!thread.length) return notify(ctx, "No BTW thread to summarize.", "warning");
		try {
			const { answer, usage } = await ask(ctx, SUMMARY_PROMPT, new AbortController().signal);
			const message = `Summary of my BTW side conversation:\n\n${answer}`;
			if (ctx.isIdle()) pi.sendUserMessage(message);
			else pi.sendUserMessage(message, { deliverAs: "followUp" });
			resetThread(true);
			notify(ctx, `Injected the BTW summary into the main chat (${formatUsage(usage)}).`, "info");
		} catch (error) {
			notify(ctx, `BTW summary failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	}

	async function closeFlow(ctx: ExtensionContext): Promise<void> {
		overlay?.close();
		if (!ctx.hasUI || !thread.length || (pending && !pending.error)) return;
		const choice = await ctx.ui.select("Close BTW:", [KEEP, INJECT, DISCARD]);
		if (choice === INJECT) await injectSummary(ctx);
		else if (choice === DISCARD) resetThread(true);
	}

	function openOverlay(ctx: ExtensionCommandContext): void {
		if (ctx.mode !== "tui" || overlay) return overlay?.refresh();
		let done: (() => void) | undefined;
		let tui: TUI | undefined;
		let view: BtwOverlay | undefined;
		let closed = false;
		const handle = {
			refresh: () => tui?.requestRender(),
			close: () => {
				if (closed) return;
				closed = true;
				if (overlay === handle) overlay = undefined;
				draft = view?.getDraft() ?? draft;
				done?.();
			},
		};
		overlay = handle;
		void ctx.ui
			.custom<void>((tuiRef, theme, keybindings, finish) => {
				tui = tuiRef;
				done = finish;
				view = new BtwOverlay(tuiRef, theme, keybindings, (width) => transcript(width, theme), () => status, (value) => {
					const question = value.trim();
					if (!question) return setStatus("Type a question first.");
					const expanded = expandBtwInput(question, loadBtwPrompts(btwPromptsDir()));
					if ("error" in expanded) return setStatus(expanded.error);
					view?.setDraft("");
					draft = "";
					void runQuestion(ctx, question, expanded.text);
				}, () => void closeFlow(ctx));
				view.setDraft(draft);
				view.focused = true;
				if (closed) finish();
				return view;
			}, { overlay: true, overlayOptions: { width: "80%", minWidth: 72, maxHeight: "78%", anchor: "top-center", margin: { top: 1, left: 2, right: 2 } } })
			.catch((error) => notify(ctx, error instanceof Error ? error.message : String(error), "error"))
			.finally(() => {
				if (overlay === handle) overlay = undefined;
			});
	}

	function restoreThread(ctx: ExtensionContext): void {
		abort?.abort();
		overlay?.close();
		pending = undefined;
		status = "Ready";
		draft = "";
		const branch = ctx.sessionManager.getBranch();
		const reset = branch.findLastIndex((entry) => entry.type === "custom" && entry.customType === RESET_TYPE);
		thread = branch.slice(reset + 1).flatMap((entry) => {
			const turn = entry.type === "custom" && entry.customType === ENTRY_TYPE ? (entry.data as BtwTurn | undefined) : undefined;
			return turn?.question && Array.isArray(turn.messages) ? [turn] : [];
		});
	}

	pi.registerCommand("btw", {
		description: "Side chat about the main session, reusing its prompt cache. `/btw <question>` or `/btw /<prompt> [args]` asks right away; `/btw inject` or `/btw reset`",
		getArgumentCompletions: (prefix) => btwCompletions(prefix, loadBtwPrompts(btwPromptsDir())),
		handler: async (args, ctx) => {
			const question = args.trim();
			if (question === "inject") return injectSummary(ctx);
			if (question === "reset") return resetThread(true);
			const expanded = expandBtwInput(question, loadBtwPrompts(btwPromptsDir()));
			if ("error" in expanded) return notify(ctx, expanded.error, "warning");
			if (!question && thread.length && ctx.hasUI && !overlay) {
				const choice = await ctx.ui.select("BTW side chat:", ["Continue previous thread", "Start fresh"]);
				if (!choice) return;
				if (choice === "Start fresh") resetThread(true);
			}
			openOverlay(ctx);
			if (question) await runQuestion(ctx, question, expanded.text);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		captured = undefined;
		capturedJson = "";
		restoreThread(ctx);
	});
	pi.on("session_tree", (_event, ctx) => restoreThread(ctx));
	pi.on("session_shutdown", () => {
		abort?.abort();
		overlay?.close();
	});
}
