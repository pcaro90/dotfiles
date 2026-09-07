#!/usr/bin/env node
import { spawn, execFileSync } from "node:child_process";
import {
  accessSync,
  constants,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import net from "node:net";
import {
  Cdp,
  artifactPath,
  cacheRoot,
  cli,
  debugPort,
  integerOption,
  isEndpointUp,
  isMain,
  isProcessAlive,
  listPageTargets,
  managedEndpoint,
  parseTab,
  privateDirectory,
  processIdentity,
  readSessionState,
  requestJson,
  safeUrl,
  selectPageTarget,
  sleep,
  takeValue,
  withLock,
  writeStateRecord,
} from "./shared.js";
import { deviceNote } from "./devices.js";

export const usage = `Usage: session.js start|stop|status|tabs|close [options]
start: [--headed | --headless] [--no-sandbox] [--port N]
       [--profile [--profile-source DIR]] [--reset-profile]
close: [--tab NUMBER|TARGET_ID]
All commands: [--max-chars N]
Defaults: headless, sandbox enabled, isolated reusable profile, port 9222.
BROWSER_BIN overrides Chromium; BROWSER_HOME isolates all state/artifacts.
--profile explicitly copies a real profile; use only with authorization and a closed source browser.`;
export function parseStartArgs(argv, environment = process.env) {
  const options = {
    headless: true,
    noSandbox: false,
    port: debugPort(environment),
    portExplicit: !!environment.BROWSER_DEBUG_PORT,
    profile: false,
    resetProfile: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--headed") options.headless = false;
    else if (arg === "--headless") options.headless = true;
    else if (arg === "--no-sandbox") options.noSandbox = true;
    else if (arg === "--profile") options.profile = true;
    else if (arg === "--reset-profile") options.resetProfile = true;
    else if (arg === "--profile-source") {
      options.profileSource = path.resolve(takeValue(argv, i++, arg));
    } else if (arg === "--port") {
      options.port = integerOption(takeValue(argv, i++, arg), arg, 1, 65535);
      options.portExplicit = true;
    } else throw new Error(`Unknown start option: ${arg}`);
  }
  if (options.profileSource && !options.profile)
    throw new Error("--profile-source requires --profile");
  return options;
}
export function chromiumCandidates(
  home = homedir(),
  platform = process.platform,
) {
  const system =
    platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
      : [
          "/usr/bin/chromium",
          "/usr/bin/chromium-browser",
          "/usr/bin/google-chrome-stable",
          "/usr/bin/google-chrome",
          "/opt/google/chrome/chrome",
          "/snap/bin/chromium",
        ];
  const root =
    process.env.PLAYWRIGHT_BROWSERS_PATH ||
    (platform === "darwin"
      ? path.join(home, "Library", "Caches", "ms-playwright")
      : path.join(home, ".cache", "ms-playwright"));
  let builds = [];
  try {
    builds = readdirSync(root)
      .filter((name) => /^chromium-\d+$/.test(name))
      .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
  } catch {}
  return [
    ...system,
    ...builds.flatMap((build) =>
      platform === "darwin"
        ? [
            path.join(
              root,
              build,
              "chrome-mac",
              "Chromium.app",
              "Contents",
              "MacOS",
              "Chromium",
            ),
            path.join(
              root,
              build,
              "chrome-mac-arm64",
              "Google Chrome for Testing.app",
              "Contents",
              "MacOS",
              "Google Chrome for Testing",
            ),
          ]
        : [
            path.join(root, build, "chrome-linux64", "chrome"),
            path.join(root, build, "chrome-linux", "chrome"),
          ],
    ),
  ];
}
export function findChromium() {
  const candidates = process.env.BROWSER_BIN
    ? [process.env.BROWSER_BIN]
    : chromiumCandidates();
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  throw new Error(
    process.env.BROWSER_BIN
      ? `BROWSER_BIN is missing or not executable: ${process.env.BROWSER_BIN}`
      : "No Chrome/Chromium found. Install one or set BROWSER_BIN=/path/to/chrome.",
  );
}
export function chromeArguments(options, userDataDir) {
  return [
    `--remote-debugging-port=${options.port}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${userDataDir}`,
    "--profile-directory=Default",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-search-engine-choice-screen",
    "--enable-automation",
    "--window-size=1280,800",
    ...(options.headless ? ["--headless=new"] : []),
    ...(options.noSandbox ? ["--no-sandbox"] : []),
    "about:blank",
  ];
}
async function assertPortFree(port) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", () =>
      reject(
        new Error(
          `Port ${port} is in use; choose --port <other>. No existing browser was touched.`,
        ),
      ),
    );
    server.listen(port, "127.0.0.1", () => server.close(resolve));
  });
}
function logTail(file) {
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .slice(-6)
      .join("\n")
      .slice(-3000);
  } catch {
    return "(no browser log)";
  }
}
function assertProfileIdle(directory, label) {
  try {
    const lock = readlinkSync(path.join(directory, "SingletonLock"));
    const pid = Number(lock.slice(lock.lastIndexOf("-") + 1));
    if (isProcessAlive(pid))
      throw new Error(
        `${label} profile is in use by pid ${pid}; stop that browser before copying, resetting, or launching it.`,
      );
  } catch (error) {
    if (!["ENOENT", "EINVAL"].includes(error.code)) throw error;
  }
}
function removeStaleProfileLocks(directory) {
  for (const name of [
    "SingletonCookie",
    "SingletonLock",
    "SingletonSocket",
    "DevToolsActivePort",
    "DevToolsActivePort.lock",
  ])
    rmSync(path.join(directory, name), { force: true });
}
async function startupConnection(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("Startup WebSocket timed out"));
    }, 3000);
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
        reject(new Error("Startup WebSocket failed"));
      },
      { once: true },
    );
  });
  return new Cdp(socket);
}
export async function runStart(options) {
  return withLock("action", async () => {
    const existing = readSessionState();
    if (existing && isProcessAlive(existing.pid)) {
      await managedEndpoint();
      if (
        options.resetProfile ||
        options.profile !== existing.profileCopy ||
        (options.portExplicit && options.port !== existing.port) ||
        options.headless !== existing.headless ||
        options.noSandbox !== existing.noSandbox
      )
        throw new Error(
          "Managed Chrome already runs with different options. Stop it before changing profile, port, mode, or sandbox.",
        );
      return `Chrome already running on ${existing.port}; profile preserved.`;
    }
    await assertPortFree(options.port);
    const binary = findChromium();
    const userDataDir = path.join(
      cacheRoot(),
      "browser",
      options.profile ? "profile-copy" : "fresh-profile",
    );
    // Never reset/copy over a profile whose Chrome singleton belongs to a live process.
    assertProfileIdle(userDataDir, "Managed destination");
    if (options.resetProfile)
      rmSync(userDataDir, { recursive: true, force: true });
    privateDirectory(userDataDir);
    if (options.profile) {
      const source =
        options.profileSource ||
        (process.platform === "darwin"
          ? path.join(
              homedir(),
              "Library",
              "Application Support",
              "Google",
              "Chrome",
            )
          : path.join(homedir(), ".config", "google-chrome"));
      if (!existsSync(source))
        throw new Error(`Profile source not found: ${source}`);
      if (
        path.resolve(source) === userDataDir ||
        userDataDir.startsWith(path.resolve(source) + path.sep) ||
        path.resolve(source).startsWith(userDataDir + path.sep)
      )
        throw new Error(
          "Profile source and destination must be separate directories",
        );
      assertProfileIdle(source, "Source");
      execFileSync(
        "rsync",
        [
          "-a",
          "--delete",
          "--exclude=Singleton*",
          "--exclude=DevToolsActivePort*",
          `${source}/`,
          `${userDataDir}/`,
        ],
        { stdio: "pipe", timeout: 120000 },
      );
      removeStaleProfileLocks(userDataDir);
    }
    const log = artifactPath("chrome", "log");
    const fd = openSync(log, "wx", 0o600);
    const child = spawn(binary, chromeArguments(options, userDataDir), {
      detached: true,
      stdio: ["ignore", fd, fd],
    });
    closeSync(fd);
    let exitReason;
    child.on("error", (error) => {
      exitReason = error.message;
    });
    child.on("exit", (code, signal) => {
      exitReason = signal || `exit ${code}`;
    });
    child.unref();
    const identity = processIdentity(child.pid);
    try {
      for (let attempt = 0; attempt < 60 && !exitReason; attempt++) {
        if (await isEndpointUp(options.port)) {
          const version = await requestJson(
            `http://127.0.0.1:${options.port}/json/version`,
          );
          const cdp = await startupConnection(version.webSocketDebuggerUrl);
          try {
            const { processInfo } = await cdp.send("SystemInfo.getProcessInfo");
            if (
              !processInfo.some(
                (info) => info.type === "browser" && info.id === child.pid,
              )
            )
              throw new Error(
                "Port is served by a different browser; refusing to adopt it",
              );
          } finally {
            cdp.close();
          }
          writeStateRecord({
            version: 2,
            pid: child.pid,
            processIdentity: identity,
            port: options.port,
            webSocketDebuggerUrl: version.webSocketDebuggerUrl,
            userDataDir,
            binary,
            headless: options.headless,
            noSandbox: options.noSandbox,
            profileCopy: options.profile,
            startedAt: new Date().toISOString(),
            tabs: [],
            nextTab: 1,
            emulation: {},
          });
          return `Started ${binary}\nendpoint: 127.0.0.1:${options.port}\nprofile: ${userDataDir}\n${options.headless ? "headless" : "headed"}; sandbox ${options.noSandbox ? "DISABLED (explicit opt-out)" : "enabled"}\nlog: ${log}`;
        }
        await sleep(150);
      }
      throw new Error(exitReason || "startup timed out");
    } catch (error) {
      if (
        child.pid &&
        isProcessAlive(child.pid) &&
        (!identity || identity === processIdentity(child.pid))
      ) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {}
      }
      throw new Error(
        `Chrome failed: ${error.message}\n${logTail(log)}\nLog: ${log}. Use --no-sandbox only if the log identifies a sandbox restriction.`,
      );
    }
  });
}
export async function runStop() {
  return withLock("action", async () => {
    const state = readSessionState();
    if (!state) return "No managed Chrome";
    if (!isProcessAlive(state.pid)) {
      writeStateRecord({});
      return "Managed Chrome was already gone; state cleared.";
    }
    await managedEndpoint();
    const cdp = await Cdp.open();
    try {
      await cdp.send("Browser.close").catch((error) => {
        if (!/disconnect|closed/i.test(error.message)) throw error;
      });
    } finally {
      cdp.close();
    }
    for (let i = 0; i < 50 && isProcessAlive(state.pid); i++) await sleep(100);
    if (isProcessAlive(state.pid))
      throw new Error(
        "Chrome has not exited; state retained. Inspect status rather than killing an unverified PID.",
      );
    writeStateRecord({});
    return "Stopped managed Chrome; cookies and profile preserved.";
  });
}
export async function runStatus() {
  return withLock("action", async () => {
    const state = readSessionState();
    if (!state) return `No managed Chrome. State directory: ${cacheRoot()}`;
    await managedEndpoint();
    const cdp = await Cdp.open();
    try {
      const pages = await listPageTargets(cdp);
      return `endpoint: 127.0.0.1:${state.port} (verified)\nprofile: ${state.userDataDir}\nbinary: ${state.binary}\nsandbox: ${state.noSandbox ? "DISABLED" : "enabled"}\nPer-tab preferences (reapplied on every action/read):\n${pages.map((page) => `${page.tab}. ${page.targetId} · ${deviceNote(state.emulation?.[page.targetId])}`).join("\n")}`;
    } finally {
      cdp.close();
    }
  });
}
export async function runTabs(close, selector) {
  return withLock("action", async () => {
    const cdp = await Cdp.open();
    try {
      const pages = await listPageTargets(cdp);
      if (close) {
        const { target } = selectPageTarget(pages, selector);
        await cdp.send("Target.closeTarget", { targetId: target.targetId });
        await listPageTargets(cdp);
        return `Closed tab ${target.tab}`;
      }
      return (
        pages
          .map(
            (page) =>
              `${page.tab}. ${page.targetId} · ${safeUrl(page.url)} · ${page.title}`,
          )
          .join("\n") || "No tabs; use nav.js <url> --new"
      );
    } finally {
      cdp.close();
    }
  });
}
export async function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return usage;
  const [command = "status", ...rest] = argv;
  if (command === "start") return runStart(parseStartArgs(rest));
  if (command === "close") {
    if (rest.length && (rest.length !== 2 || rest[0] !== "--tab"))
      throw new Error("close accepts only --tab <number|id>");
    return runTabs(true, rest.length ? parseTab(rest[1]) : undefined);
  }
  if (rest.length)
    throw new Error(`Unexpected option for ${command}: ${rest[0]}`);
  if (command === "status") return runStatus();
  if (command === "stop") return runStop();
  if (command === "tabs") return runTabs();
  throw new Error(usage);
}
if (isMain(import.meta.url)) await cli(main);
