/**
 * notify — desktop notifications when Pi finishes a run ("π · ready") or waits for input.
 *
 * Nothing is sent while the Pi window has focus (Sway: the container whose pid is an ancestor
 * of this process; under tmux/ssh focus is unknown, so it always notifies). On Sway the
 * notification has a "Focus π" button: a `notify-send --wait` child prints the action when it
 * is clicked and the window is focused. Only this instance's latest listener stays alive; the
 * previous one is aborted. If `notify-send` fails, rings the terminal bell from then on (only
 * when stdout is a TTY, so print mode output is never corrupted).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { relative } from "node:path";

const APP = "π";
const TIMEOUT_MS = 1_000;

/** This process and its ancestors, walking up through /proc. */
function ancestorPids(): Set<number> {
	const pids = new Set<number>();
	for (let pid = process.pid; pid > 1 && !pids.has(pid);) {
		pids.add(pid);
		try {
			pid = Number(readFileSync(`/proc/${pid}/stat`, "utf8").match(/^\d+ \(.*\) \w (\d+)/)?.[1] ?? 0);
		} catch {
			break;
		}
	}
	return pids;
}

function shortCwd(cwd: string): string {
	const rel = relative(homedir(), cwd);
	return rel && !rel.startsWith("..") ? `~/${rel}` : cwd;
}

function formatDuration(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	return s % 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${s / 60}m`;
}

export default function notify(pi: ExtensionAPI): void {
	let capable = true;
	let ancestors: Set<number> | undefined;
	let listener: AbortController | undefined;
	let runStartedAt: number | undefined;
	const activeTools = new Map<string, string>(); // toolCallId → toolName

	const bell = () => { if (process.stdout.isTTY) process.stdout.write("\x07"); };
	const stopListener = () => { listener?.abort(); listener = undefined; };

	/** Our Sway window and whether it has focus; undefined when it cannot be determined. */
	async function swayWindow(): Promise<{ pid: number; focused: boolean } | undefined> {
		if (!process.env.SWAYSOCK) return undefined;
		try {
			const result = await pi.exec("swaymsg", ["-t", "get_tree", "--raw"], { timeout: TIMEOUT_MS });
			if (result.code !== 0) return undefined;
			ancestors ??= ancestorPids();
			const stack = [JSON.parse(result.stdout)];
			while (stack.length) {
				const node = stack.pop();
				if (ancestors.has(node?.pid)) return { pid: node.pid, focused: !!node.focused };
				stack.push(...(node?.nodes ?? []), ...(node?.floating_nodes ?? []));
			}
		} catch {}
		return undefined;
	}

	async function send(title: string, body: string): Promise<void> {
		const window = await swayWindow();
		if (window?.focused) return; // the user is already looking at Pi
		if (!capable) return bell();
		stopListener();
		// With a known window, wait for the "Focus π" button; otherwise a plain fire-and-forget notification.
		const controller = window && (listener = new AbortController());
		const args = ["--app-name", APP, "--urgency", "normal", ...(window ? ["--wait", "--action", "pi-focus=Focus π"] : []), "--", title, body];
		try {
			const result = await pi.exec("notify-send", args, controller ? { signal: controller.signal } : { timeout: 1_500 });
			if (controller?.signal.aborted) return; // superseded or shut down: not a failure
			if (result.code !== 0) throw new Error(result.stderr);
			if (window && result.stdout.trim()) await pi.exec("swaymsg", [`[pid=${window.pid}]`, "focus"], { timeout: TIMEOUT_MS });
		} catch {
			if (controller?.signal.aborted) return;
			capable = false;
			bell();
		} finally {
			if (listener === controller) listener = undefined;
		}
	}

	pi.on("before_agent_start", () => {
		runStartedAt = Date.now();
	});

	pi.on("agent_settled", (_event, ctx) => {
		const fields = [shortCwd(ctx.cwd)];
		if (runStartedAt !== undefined) fields.push(formatDuration(Date.now() - runStartedAt));
		runStartedAt = undefined;
		activeTools.clear(); // drop traces of aborted runs
		const name = pi.getSessionName();
		if (name) fields.push(name);
		const model = (ctx.model?.name ?? ctx.model?.id)?.split("/").pop();
		if (model) fields.push(model);
		void send(`${APP} · ready`, fields.join(" · "));
	});

	// Track the tool that is blocking, for the prompt body.
	pi.on("tool_execution_start", (event) => { activeTools.set(event.toolCallId, event.toolName); });
	pi.on("tool_execution_end", (event) => { activeTools.delete(event.toolCallId); });

	pi.on("ui_prompt_start", (event, ctx) => {
		const tool = [...activeTools.values()].at(-1);
		void send(`${APP} · waiting for your input`, [tool ? `waiting for input from ${tool}` : (event.title ?? "needs your attention"), shortCwd(ctx.cwd)].join(" · "));
	});

	// Never leave the click listener behind, also when Pi exits without a session shutdown.
	pi.on("session_start", () => { process.on("exit", stopListener); });
	pi.on("session_shutdown", () => {
		stopListener();
		process.off("exit", stopListener);
	});
}
