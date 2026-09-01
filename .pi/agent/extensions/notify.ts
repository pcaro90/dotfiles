/**
 * notify — desktop notifications for pi.
 *
 * Triggers:
 *   - agent_settled   → "π · ready"                  (normal urgency)
 *   - ui_prompt_start → "π · waiting for your input" (normal urgency)
 *
 * Rules per event:
 *   1) notify-send available AND focus is determinable → notify only when
 *      the window does NOT have focus (sway tree, matched by container pid).
 *   2) notify-send available but focus not determinable → notify always.
 *   3) notify-send unavailable → BEL (\x07), only when stdout is a real TTY.
 *
 * Click-to-focus:
 *   When focus is determinable, the notification includes a "Focus π"
 *   button. swaync emits ActionInvoked back to the notification's creator
 *   — a `notify-send --wait` child spawned by this extension — which prints
 *   the action to stdout on activation; the extension then runs
 *   `swaymsg [pid=<windowPid>] focus`.
 *
 *   Only ONE listener is alive at a time: the previous child of THIS pi
 *   instance is aborted (via its own AbortController → pi.exec kills that
 *   child) before the next notification is sent, so we never touch a
 *   notify-send owned by another process or another pi instance.
 *
 * Capability probes and the window container pid are resolved once per
 * process and cached; "focused" is re-read from the sway tree on every
 * event (≈3 ms). No timers, sockets or watchers in the factory; the only
 * long-lived thing is the single click listener child, cleaned up on
 * session shutdown.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative } from "node:path";

const APP_NAME = "π";
const PROBE_TIMEOUT_MS = 1_000;
const NOTIFY_TIMEOUT_MS = 1_500;

// ── Cached state (per pi process, not the session) ───────────────────────
let notifyCapable: boolean | undefined;
let windowPid: number | undefined;
let windowPidResolved = false;

const activeTools = new Map<string, string>(); // toolCallId → toolName
let runStartedAt: number | undefined;
let activePi = null as ExtensionAPI | null; // set by the factory

// AbortController of this pi instance's in-flight `notify-send --wait`
// listener (the click-to-focus child). Only ever aborted by us.
let clickAbort: AbortController | null = null;

// ── Utils ─────────────────────────────────────────────────────────────────

/** Ancestor pids of a process, walking up through /proc. */
function ancestorPids(start: number): number[] {
  const chain: number[] = [];
  let pid = start;
  while (pid > 1) {
    chain.push(pid);
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const m = stat.match(/^\d+ \(.*\) \w (\d+)/);
      if (!m) break;
      pid = Number(m[1]);
    } catch {
      break;
    }
  }
  return chain;
}

function ringBell(): void {
  // Only when stdout is a real TTY: in print mode (-p) stdout is the
  // agent output and a \x07 would corrupt it.
  if (process.stdout.isTTY) process.stdout.write("\x07");
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest ? `${m}m${String(rest).padStart(2, "0")}s` : `${m}m`;
}

/** cwd shown relative to the home dir: ~/path/to/project */
function shortCwd(cwd: string): string {
  if (!cwd) return "";
  const rel = relative(homedir(), cwd);
  return rel.startsWith("..") || rel === "" ? cwd : `~/${rel}`;
}

/** Short model id: "anthropic/claude-sonnet-4-5" → "claude-sonnet-4-5" */
function shortModel(modelId: string | undefined): string | undefined {
  const short = modelId?.split("/").pop();
  return short && short.length > 0 ? short : undefined;
}

function sessionName(): string | undefined {
  try {
    return activePi?.getSessionName?.() ?? undefined;
  } catch {
    return undefined;
  }
}

/** Extra context for the body, cheap to obtain, never failing. */
function contextFields(ctx: { cwd: string }, opts: Extras): string[] {
  const fields = [shortCwd(ctx.cwd)];
  if (opts.durationMs !== undefined) fields.push(fmtDuration(opts.durationMs));
  const name = sessionName();
  if (name) fields.push(name);
  const model = shortModel(opts.modelId);
  if (model) fields.push(model);
  return fields;
}

interface Extras {
  durationMs?: number;
  modelId?: string;
}

// ── Probes with per-process cache ─────────────────────────────────────────

/** Is there a notification daemon to talk to? (silent, resolved once) */
async function ensureNotifyCapable(): Promise<boolean> {
  if (notifyCapable !== undefined) return notifyCapable;
  const rt = process.env.XDG_RUNTIME_DIR;
  const bus = process.env.DBUS_SESSION_BUS_ADDRESS;
  const socketOk = !!bus || (!!rt && existsSync(join(rt, "bus")));
  if (!socketOk) {
    notifyCapable = false;
    return false;
  }
  try {
    const r = await activePi!.exec("gdbus", [
      "call", "--session",
      "--dest", "org.freedesktop.Notifications",
      "--object-path", "/org/freedesktop/Notifications",
      "--method", "org.freedesktop.Notifications.GetServerInformation",
    ], { timeout: PROBE_TIMEOUT_MS });
    notifyCapable = r.code === 0;
  } catch {
    notifyCapable = false;
  }
  return notifyCapable;
}

/** sway container pid hosting this pi instance (resolved once). */
async function resolveWindowPid(): Promise<number | undefined> {
  if (windowPidResolved) return windowPid;
  windowPidResolved = true;
  if (!process.env.SWAYSOCK) return undefined;
  const tree = await getTree();
  if (!tree) return undefined;
  const containerPids = new Set<number>();
  (function walk(n: any) {
    if (typeof n?.pid === "number") containerPids.add(n.pid);
    for (const c of [...(n?.nodes ?? []), ...(n?.floating_nodes ?? [])]) walk(c);
  })(tree);
  for (const pid of ancestorPids(process.pid)) {
    if (containerPids.has(pid)) {
      windowPid = pid;
      return pid;
    }
  }
  return undefined; // tmux/ssh/etc → focus not determinable
}

async function getTree(): Promise<any> {
  try {
    const r = await activePi!.exec("swaymsg", ["-t", "get_tree", "--raw"], {
      timeout: PROBE_TIMEOUT_MS,
    });
    return r.code === 0 ? JSON.parse(r.stdout) : null;
  } catch {
    return null;
  }
}

/**
 * Does the pi window have focus?
 *  - true/false   → determinable (rule 1)
 *  - undefined    → not determinable (tmux/ssh/other compositor, or swaymsg broken)
 */
async function isFocused(): Promise<boolean | undefined> {
  const pid = await resolveWindowPid();
  if (pid === undefined) return undefined;
  const tree = await getTree();
  if (!tree) return undefined;
  let focused: boolean | undefined;
  (function walk(n: any) {
    if (focused !== undefined) return;
    if (n?.pid === pid) focused = !!n.focused;
    for (const c of [...(n?.nodes ?? []), ...(n?.floating_nodes ?? [])]) walk(c);
  })(tree);
  return focused;
}

// ── Sending ───────────────────────────────────────────────────────────────

/** Kill ONLY the click listener of THIS pi instance (identity-based). */
function stopCurrentListener(): void {
  clickAbort?.abort();
  clickAbort = null;
}

/** Focus this pi instance's sway window (best effort). */
function focusThisWindow(): void {
  const pid = windowPid;
  if (pid === undefined) return;
  activePi!.exec("swaymsg", [`[pid=${pid}]`, "focus"], {
    timeout: PROBE_TIMEOUT_MS,
  }).catch(() => {});
}

/** Plain notification (no button): fire-and-forget. */
function sendPlain(opts: { urgency: "normal" | "critical"; title: string; body: string }): void {
  (async () => {
    try {
      const r = await activePi!.exec("notify-send", [
        "--app-name", APP_NAME,
        "--urgency", opts.urgency,
        "--", opts.title, opts.body,
      ], { timeout: NOTIFY_TIMEOUT_MS });
      if (r.code !== 0) throw new Error(r.stderr || `exit ${r.code}`);
    } catch {
      notifyCapable = false; // degrade for the rest of the process
      ringBell();
    }
  })();
}

/**
 * Notification with a "Focus π" button. The `notify-send --wait` child
 * stays connected to the bus and prints the action key to stdout when the
 * button is clicked; on non-empty stdout we focus our window.
 *
 * Before spawning, the previous listener of THIS instance is aborted; a
 * killed (superseded) child is ignored via its own signal state.
 */
function sendClickable(opts: { urgency: "normal" | "critical"; title: string; body: string }): void {
  stopCurrentListener();
  const controller = new AbortController();
  clickAbort = controller;
  activePi!.exec("notify-send", [
    "--wait",
    "--app-name", APP_NAME,
    "--urgency", opts.urgency,
    "--action", "pi-focus=Focus π",
    "--", opts.title, opts.body,
  ], { signal: controller.signal }).then((r) => {
    if (clickAbort === controller) clickAbort = null;
    if (controller.signal.aborted) return; // superseded or shutdown: not a failure
    if (r.code !== 0) {
      notifyCapable = false; // display failure → degrade + bell
      ringBell();
      return;
    }
    if (r.stdout.trim().length > 0) focusThisWindow(); // button clicked
  }).catch(() => {
    if (clickAbort === controller) clickAbort = null;
  });
}

function maybeNotify(opts: { urgency: "normal" | "critical"; title: string; body: string }): void {
  (async () => {
    if (!(await ensureNotifyCapable())) {
      ringBell();
      return;
    }
    const focused = await isFocused();
    if (focused === true) return; // the user is already looking at pi
    if (windowPid !== undefined) sendClickable(opts); // click can focus our window
    else sendPlain(opts);                              // no window known → no button
  })();
}

// ── Extension ─────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  activePi = pi;

  pi.on("before_agent_start", () => {
    runStartedAt = Date.now();
  });

  pi.on("agent_settled", (_event, ctx) => {
    const durationMs = runStartedAt !== undefined ? Date.now() - runStartedAt : undefined;
    runStartedAt = undefined;
    activeTools.clear(); // drop traces of aborted runs
    maybeNotify({
      urgency: "normal",
      title: `${APP_NAME} · ready`,
      body: contextFields(ctx, { durationMs, modelId: ctx.model?.name ?? ctx.model?.id }).join(" · "),
    });
  });

  // Track the tool that is blocking, for the prompt body.
  pi.on("tool_execution_start", (event) => {
    activeTools.set(event.toolCallId, event.toolName);
  });
  pi.on("tool_execution_end", (event) => {
    activeTools.delete(event.toolCallId);
  });

  pi.on("ui_prompt_start", (event, ctx) => {
    const tools = [...activeTools.values()];
    const who = tools.length > 0 ? tools[tools.length - 1] : undefined;
    const fields = [who ? `waiting for input from ${who}` : (event.title ?? "needs your attention")];
    fields.push(shortCwd(ctx.cwd));
    maybeNotify({
      urgency: "normal",
      title: `${APP_NAME} · waiting for your input`,
      body: fields.join(" · "),
    });
  });

  // Cleanup: never leave listeners behind.
  pi.on("session_shutdown", () => stopCurrentListener());
  process.once("exit", stopCurrentListener);
}
