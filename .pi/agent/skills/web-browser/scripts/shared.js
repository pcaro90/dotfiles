import {
  constants,
  closeSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

export const defaultDebugPort = 9222;
export const defaultWindow = { width: 1280, height: 800 };
export const defaultMaxChars = 6000;
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const cacheRoot = () =>
  process.env.BROWSER_HOME || path.join(homedir(), ".cache", "agent-web");
export const stateFile = () => path.join(cacheRoot(), "session.json");
export function privateDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}
export const artifactsDirectory = () =>
  privateDirectory(path.join(cacheRoot(), "artifacts"));
export const artifactPath = (prefix, suffix) =>
  path.join(
    artifactsDirectory(),
    `${prefix}-${Date.now()}-${randomUUID().slice(0, 8)}.${suffix}`,
  );
export const stringValue = (value) => (typeof value === "string" ? value : "");
export const recordValue = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};
export const recordsValue = (value) =>
  Array.isArray(value) ? value.map(recordValue) : [];
export function render(value) {
  return typeof value === "string" ? value : (JSON.stringify(value) ?? "");
}

/** Bound the ENTIRE output, including headers and continuation notice. */
export function compact(value, maxChars = defaultMaxChars) {
  const text = render(value);
  if (text.length <= maxChars) return text;
  const note = "\n[truncated; raise --max-chars or use --out for full content]";
  return maxChars < note.length
    ? "[truncated]".slice(0, maxChars)
    : text.slice(0, maxChars - note.length) + note;
}
export function privateWrite(file, contents) {
  file = path.resolve(file);
  privateDirectory(path.dirname(file));
  // Refuse symlinks, including pre-existing output paths; enforce private file modes.
  const fd = openSync(
    file,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_TRUNC |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fchmodSync(fd, 0o600);
    writeFileSync(fd, contents);
  } finally {
    closeSync(fd);
  }
  return file;
}
export function readStateRecord() {
  try {
    return recordValue(JSON.parse(readFileSync(stateFile(), "utf8")));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw new Error(
      `Invalid browser state at ${stateFile()}: ${error.message}`,
    );
  }
}
export function writeStateRecord(state) {
  privateDirectory(cacheRoot());
  const temporary = `${stateFile()}.${randomUUID()}.tmp`;
  privateWrite(temporary, JSON.stringify(state, null, 2) + "\n");
  renameSync(temporary, stateFile());
}
export function updateState(change) {
  const state = readStateRecord();
  change(state);
  writeStateRecord(state);
  return state;
}
export function readSessionState() {
  const state = readStateRecord();
  return state.pid ? state : null;
}
export function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
/** Linux start time prevents PID reuse from turning stop into an unrelated process kill. */
export function processIdentity(pid) {
  if (process.platform !== "linux") return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[19];
  } catch {
    return null;
  }
}
export function debugPort(environment = process.env) {
  const raw = environment.BROWSER_DEBUG_PORT;
  return raw === undefined
    ? defaultDebugPort
    : integerOption(raw, "BROWSER_DEBUG_PORT", 1, 65535);
}
export async function requestJson(url, timeoutMs = 1500) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}
export async function isEndpointUp(port) {
  try {
    await requestJson(`http://127.0.0.1:${port}/json/version`);
    return true;
  } catch {
    return false;
  }
}
export async function managedEndpoint() {
  const state = readSessionState();
  if (!state?.webSocketDebuggerUrl || !isProcessAlive(state.pid)) {
    throw new Error("No verified managed Chrome. Run session.js start.");
  }
  if (
    state.processIdentity &&
    processIdentity(state.pid) !== state.processIdentity
  )
    throw new Error("Browser PID identity changed; refusing to attach.");
  if (process.env.BROWSER_DEBUG_PORT && debugPort() !== state.port)
    throw new Error(
      `BROWSER_DEBUG_PORT disagrees with managed port ${state.port}; unset it or stop and restart.`,
    );
  const version = await requestJson(
    `http://127.0.0.1:${state.port}/json/version`,
  ).catch(() => {
    throw new Error(
      `Managed Chrome is not answering on ${state.port}; inspect session.js status.`,
    );
  });
  if (version.webSocketDebuggerUrl !== state.webSocketDebuggerUrl)
    throw new Error(
      "Debugging endpoint identity changed; refusing to touch another browser.",
    );
  return state;
}

/** One foreground action at a time. A trace uses its own lock and launches ordinary actions. */
export async function withLock(
  name,
  action,
  bypassTraceToken = process.env.BROWSER_TRACE_TOKEN,
) {
  privateDirectory(cacheRoot());
  if (name === "action") {
    const traceFile = path.join(cacheRoot(), "trace.lock");
    try {
      const trace = JSON.parse(readFileSync(traceFile, "utf8"));
      if (
        isProcessAlive(trace.pid) &&
        (!trace.identity || processIdentity(trace.pid) === trace.identity) &&
        trace.token !== bypassTraceToken
      ) {
        throw new Error(
          `A trace is active (pid ${trace.pid}); unrelated browser actions are blocked until it finishes.`,
        );
      }
    } catch (error) {
      if (error.code === "ENOENT") {
        /* No active trace. */
      } else if (/trace is active/.test(error.message)) throw error;
      else
        throw new Error(
          `Trace lock is unreadable: ${traceFile}. Wait for trace startup or inspect it before retrying.`,
        );
    }
  }
  const file = path.join(cacheRoot(), `${name}.lock`);
  const token = randomUUID();
  let owned = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, "wx", 0o600);
      try {
        writeFileSync(
          fd,
          JSON.stringify({
            pid: process.pid,
            identity: processIdentity(process.pid),
            token,
          }),
        );
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      owned = true;
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let previous;
      try {
        previous = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        throw new Error(
          `Browser lock is incomplete: ${file}. Another command may be starting; retry later.`,
        );
      }
      if (
        isProcessAlive(previous.pid) &&
        (!previous.identity ||
          processIdentity(previous.pid) === previous.identity)
      )
        throw new Error(
          `Another ${name} command is running (pid ${previous.pid}); wait for it to finish.`,
        );
      // Serialize stale-lock recovery too: otherwise two recoverers can unlink a
      // newly acquired live lock between their stale check and unlink.
      const recovery = `${file}.recover`;
      let guard;
      try {
        guard = openSync(recovery, "wx", 0o600);
      } catch (error) {
        if (error.code === "EEXIST")
          throw new Error(
            `Lock recovery is in progress: ${recovery}. If its process died, inspect and remove only that recovery marker.`,
          );
        throw error;
      }
      try {
        writeFileSync(
          guard,
          JSON.stringify({
            pid: process.pid,
            identity: processIdentity(process.pid),
          }),
        );
        const current = JSON.parse(readFileSync(file, "utf8"));
        if (current.token === previous.token) unlinkSync(file);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      } finally {
        closeSync(guard);
        unlinkSync(recovery);
      }
    }
  }
  if (!owned) throw new Error(`Could not acquire ${name} lock; retry.`);
  try {
    return await action(token);
  } finally {
    try {
      if (JSON.parse(readFileSync(file, "utf8")).token === token)
        unlinkSync(file);
    } catch {}
  }
}

export class Cdp {
  #socket;
  #nextId = 0;
  #pending = new Map();
  #handlers = new Map();
  #closed = false;
  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener("message", (event) => this.#receive(event.data));
    socket.addEventListener("close", () =>
      this.#fail(new Error("Chrome disconnected")),
    );
    socket.addEventListener("error", () =>
      this.#fail(new Error("Chrome WebSocket failed")),
    );
  }
  static async open() {
    const state = await managedEndpoint();
    const socket = new WebSocket(state.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error("Chrome WebSocket connect timeout"));
      }, 5000);
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error("Chrome WebSocket connection failed"));
        },
        { once: true },
      );
    });
    return new Cdp(socket);
  }
  #fail(error) {
    this.#closed = true;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
  #receive(data) {
    let message;
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }
    if (message.id && this.#pending.has(message.id)) {
      const pending = this.#pending.get(message.id);
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
      return;
    }
    for (const handler of [...(this.#handlers.get(message.method) || [])]) {
      try {
        handler(message.params || {}, message.sessionId);
      } catch {
        /* Listener owns its errors. */
      }
    }
  }
  send(method, params = {}, sessionId, timeoutMs = 15000) {
    if (this.#closed)
      return Promise.reject(new Error("Chrome connection is closed"));
    return new Promise((resolve, reject) => {
      const id = ++this.#nextId;
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CDP call timed out: ${method}`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        this.#socket.send(
          JSON.stringify({
            id,
            method,
            params,
            ...(sessionId ? { sessionId } : {}),
          }),
        );
      } catch (error) {
        this.#pending.get(id).reject(error);
        this.#pending.delete(id);
      }
    });
  }
  on(method, handler) {
    const handlers = this.#handlers.get(method) || new Set();
    handlers.add(handler);
    this.#handlers.set(method, handlers);
    return () => handlers.delete(handler);
  }
  close() {
    this.#fail(new Error("Chrome connection closed"));
    try {
      this.#socket.close();
    } catch {}
  }
}

export async function listPageTargets(cdp) {
  const { targetInfos } = await cdp.send("Target.getTargets");
  const pages = targetInfos.filter(
    (info) => info.type === "page" && !info.url.startsWith("devtools://"),
  );
  // Never renumber an existing target, or reuse a closed tab's number during this browser run.
  const state = updateState((state) => {
    const old = state.tabs || [];
    let next = state.nextTab || 1;
    state.tabs = pages.map(
      (page) =>
        old.find((tab) => tab.targetId === page.targetId) || {
          targetId: page.targetId,
          tab: next++,
        },
    );
    state.nextTab = next;
    const alive = new Set(pages.map((page) => page.targetId));
    state.emulation = Object.fromEntries(
      Object.entries(state.emulation || {}).filter(([id]) => alive.has(id)),
    );
  });
  return pages
    .map((page) => ({
      ...page,
      tab: state.tabs.find((tab) => tab.targetId === page.targetId).tab,
    }))
    .sort((a, b) => a.tab - b.tab);
}
export function selectPageTarget(
  pages,
  selector,
  activeTargetId = readStateRecord().activeTargetId,
) {
  if (!pages.length) throw new Error("No open tabs. Run nav.js <url> --new.");
  const page =
    selector === undefined
      ? pages.find((page) => page.targetId === activeTargetId) || pages.at(-1)
      : pages.find(
          (page) =>
            String(page.tab) === String(selector) || page.targetId === selector,
        );
  if (!page)
    throw new Error(
      `Tab ${selector} does not exist. Open tabs: ${pages.map((page) => page.tab).join(", ")}. Use session.js tabs.`,
    );
  return { target: page, tab: page.tab };
}
export async function attach(cdp, targetId) {
  const { sessionId } = await cdp.send("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  if (!sessionId) throw new Error("Could not attach to tab");
  return sessionId;
}
export async function evaluate(cdp, sessionId, expression, timeoutMs = 15000) {
  const { result, exceptionDetails } = await cdp.send(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
    timeoutMs,
  );
  if (exceptionDetails)
    throw new Error(
      exceptionDetails.exception?.description ||
        exceptionDetails.text ||
        "JavaScript failed",
    );
  return result?.value;
}
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
export function wrapJavaScript(code) {
  if (!code?.trim()) throw new Error("No JavaScript was provided");
  try {
    new AsyncFunction(`return (${code});`);
    return { expression: `(async()=>(${code}))()`, form: "expression" };
  } catch {}
  try {
    new AsyncFunction(code);
  } catch (error) {
    throw new Error(
      `Invalid JavaScript: ${error.message}. Use an expression or statements with return.`,
    );
  }
  return { expression: `(async()=>{${code}\n})()`, form: "statements" };
}
export function normalizeUrl(value) {
  const input = value.trim();
  const bareHost =
    /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(input);
  const hostPort = /^(?:\[[a-f\d:]+\]|[^/?#:]+):\d{1,5}(?:[/?#]|$)/i.test(
    input,
  );
  if (/^(javascript|data|file|about|chrome):/i.test(input))
    throw new Error(
      "Only http and https URLs are supported; serve local files on loopback.",
    );
  const explicit = /^[a-z][a-z\d+.-]*:/i.test(input) && !bareHost && !hostPort;
  let url;
  try {
    url = new URL(
      explicit ? input : `${bareHost ? "http" : "https"}://${input}`,
    );
  } catch {
    throw new Error(`Invalid URL: ${value}`);
  }
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error(
      "Only http and https URLs are supported; serve local files on loopback.",
    );
  return url.href;
}
export function integerOption(value, flag, min = 1, max = 1_000_000) {
  if (!/^\d+$/.test(String(value)))
    throw new Error(`${flag} must be an integer`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max)
    throw new Error(`${flag} must be between ${min} and ${max}`);
  return number;
}
export const secondsOption = (value, flag) =>
  integerOption(value, flag, 1, 300) * 1000;
export function takeValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--"))
    throw new Error(`${flag} requires a value`);
  return value;
}
export function parseTab(value) {
  if (value === undefined)
    throw new Error("--tab requires a number or target ID");
  if (/^\d+$/.test(value)) return integerOption(value, "--tab");
  if (/^[A-Fa-f\d]{32}$/.test(value)) return value;
  throw new Error(
    "--tab requires a positive number or full target ID from session.js tabs",
  );
}
export const helpRequested = (argv) =>
  argv.includes("--help") || argv.includes("-h");
export const isMain = (url) =>
  process.argv[1] && url === pathToFileURL(path.resolve(process.argv[1])).href;
export function outputOptions(argv) {
  let maxChars = defaultMaxChars;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--max-chars") {
      maxChars = integerOption(
        takeValue(argv, i, argv[i]),
        argv[i],
        128,
        1_000_000,
      );
      i++;
    } else rest.push(argv[i]);
  }
  return { argv: rest, maxChars };
}
export async function cli(main) {
  let maxChars = defaultMaxChars;
  try {
    const parsed = outputOptions(process.argv.slice(2));
    maxChars = parsed.maxChars;
    const result = await main(parsed.argv, maxChars);
    if (result !== undefined) console.log(compact(result, maxChars));
  } catch (error) {
    console.error(compact(`Error: ${error.message}`, maxChars));
    process.exitCode = error.exitCode || 1;
  }
}
export function safeUrl(value) {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    if (url.search) url.search = "?REDACTED";
    url.hash = "";
    return url.href;
  } catch {
    return String(value).slice(0, 200);
  }
}
