#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
  artifactPath,
  attach,
  Cdp,
  cli,
  compact,
  helpRequested,
  integerOption,
  isMain,
  listPageTargets,
  parseTab,
  privateWrite,
  safeUrl,
  secondsOption,
  selectPageTarget,
  sleep,
  takeValue,
  withLock,
} from "./shared.js";

export const usage = `Usage: trace.js [--run 'SHELL COMMAND' | --seconds N]
  [--tab NUMBER|TARGET_ID | --all-tabs] [--pattern TEXT] [--all] [--details]
  [--out FILE] [--timeout SECONDS] [--settle-ms N] [--max-events N]
  [--max-chars N] [--show-messages]
Default: selected tab, 5-second window, 60-second command timeout, 500ms settling.
Capture scope is the tabs open at START: new tabs/popups are NOT recorded. Open them first.
--details stores request/response headers, cookies, POST bodies and redirect hops (0600).
Files omit response bodies and uploaded file contents. Missing/limited data is flagged.
Summary never prints headers/bodies or child output; --show-messages exposes console text.
--all retains successful static resources and console.log too; --pattern filters URL/message.
Trace storage is bounded to 20000 protocol events / 16 MiB (before serialization).
--run uses the shell; do not interpolate untrusted page content. Exit status follows the command.`;
export function parseTraceArgs(argv) {
  const options = {
    seconds: 5,
    all: false,
    details: false,
    allTabs: false,
    timeoutMs: 60000,
    settleMs: 500,
    maxEvents: 20000,
    maxBytes: 16 * 1024 * 1024,
    maxChars: 6000,
    showMessages: false,
  };
  let secondsSet = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (["--run", "--pattern", "--out"].includes(arg))
      options[arg.slice(2)] = takeValue(argv, i++, arg);
    else if (arg === "--seconds") {
      options.seconds = integerOption(takeValue(argv, i++, arg), arg, 1, 300);
      secondsSet = true;
    } else if (arg === "--timeout")
      options.timeoutMs = secondsOption(takeValue(argv, i++, arg), arg);
    else if (arg === "--settle-ms")
      options.settleMs = integerOption(takeValue(argv, i++, arg), arg, 0, 5000);
    else if (arg === "--max-events")
      options.maxEvents = integerOption(
        takeValue(argv, i++, arg),
        arg,
        1,
        100000,
      );
    else if (arg === "--max-chars")
      options.maxChars = integerOption(
        takeValue(argv, i++, arg),
        arg,
        128,
        1000000,
      );
    else if (arg === "--tab") options.tab = parseTab(takeValue(argv, i++, arg));
    else if (arg === "--all") options.all = true;
    else if (arg === "--all-tabs") options.allTabs = true;
    else if (arg === "--details") options.details = true;
    else if (arg === "--show-messages") options.showMessages = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (secondsSet && options.run)
    throw new Error("Use --run or --seconds, not both");
  if (options.allTabs && options.tab !== undefined)
    throw new Error("Use --all-tabs or --tab, not both");
  return options;
}
const important = new Set([
  "Document",
  "XHR",
  "Fetch",
  "EventSource",
  "WebSocket",
  "Preflight",
]);
export function isInteresting(entry, all) {
  if (all) return true;
  if (entry.kind === "request")
    return (
      important.has(entry.resourceType) ||
      entry.status >= 400 ||
      !!entry.errorText
    );
  return (
    entry.kind === "exception" || ["error", "warning"].includes(entry.level)
  );
}

/** Store complete request HOPS, not detached request events that a summary filter can discard. */
export class Recorder {
  constructor(options, postDataReader) {
    this.options = options;
    this.postDataReader = postDataReader;
    this.streams = new Map();
    this.entries = [];
    this.pending = new Set();
    this.eventCount = 0;
    this.bytes = 0;
    this.dropped = 0;
    this.stopped = false;
  }
  accept(method, params, sessionId) {
    if (this.stopped) return;
    const size = JSON.stringify(params).length * 2;
    if (
      ++this.eventCount > this.options.maxEvents ||
      this.bytes + size > this.options.maxBytes
    ) {
      this.dropped++;
      return;
    }
    this.bytes += size;
    const base = `${sessionId}:${params.requestId}`;
    const stream = () => {
      if (!this.streams.has(base))
        this.streams.set(base, {
          hops: [],
          requestExtras: [],
          responseExtras: [],
        });
      return this.streams.get(base);
    };
    if (method === "Network.requestWillBeSent") {
      const chain = stream(),
        request = params.request;
      const previous = chain.hops.at(-1);
      if (previous && params.redirectResponse) {
        this.response(
          previous,
          params.redirectResponse,
          params.redirectHasExtraInfo,
        );
        previous.redirectedTo = request.url;
        previous.finished = true;
      }
      const entry = {
        kind: "request",
        sessionId,
        requestId: params.requestId,
        hop: chain.hops.length + 1,
        method: request.method,
        url: request.url,
        resourceType: params.type,
        finished: false,
        timestamp: params.wallTime,
      };
      if (this.options.details)
        entry.details = {
          requestHeaders: request.headers,
          hasPostData: !!request.hasPostData,
          ...(request.postData !== undefined
            ? { postData: request.postData }
            : {}),
        };
      chain.hops.push(entry);
      this.entries.push(entry);
      if (
        this.options.details &&
        request.hasPostData &&
        request.postData === undefined &&
        this.postDataReader
      ) {
        const pending = this.postDataReader(sessionId, params.requestId)
          .then((data) => {
            if (
              data.postData !== undefined &&
              this.bytes + data.postData.length * 2 <= this.options.maxBytes
            ) {
              entry.details.postData = data.postData;
              this.bytes += data.postData.length * 2;
            } else
              entry.details.postDataError =
                "Body unavailable or capture byte budget exhausted";
          })
          .catch((error) => {
            entry.details.postDataError = error.message;
          })
          .finally(() => this.pending.delete(pending));
        this.pending.add(pending);
      }
    } else if (method === "Network.requestWillBeSentExtraInfo") {
      if (this.options.details) stream().requestExtras.push(params);
    } else if (method === "Network.responseReceivedExtraInfo") {
      if (this.options.details) stream().responseExtras.push(params);
    } else if (method === "Network.responseReceived") {
      const entry = stream().hops.at(-1);
      if (entry) this.response(entry, params.response, params.hasExtraInfo);
    } else if (
      ["Network.loadingFailed", "Network.loadingFinished"].includes(method)
    ) {
      const entry = stream().hops.at(-1);
      if (entry) {
        entry.finished = true;
        if (params.errorText) entry.errorText = params.errorText;
      }
    } else if (method === "Runtime.consoleAPICalled") {
      this.entries.push({
        kind: "console",
        sessionId,
        level: params.type,
        text: (params.args || [])
          .map((arg) =>
            String(
              arg.value ??
                arg.description ??
                arg.unserializableValue ??
                arg.type,
            ),
          )
          .join(" "),
      });
    } else if (method === "Runtime.exceptionThrown") {
      const detail = params.exceptionDetails;
      this.entries.push({
        kind: "exception",
        sessionId,
        text: detail.exception?.description || detail.text,
        url: detail.url,
      });
    } else if (method === "Log.entryAdded") {
      this.entries.push({
        kind: "console",
        sessionId,
        level: params.entry.level,
        text: params.entry.text,
        url: params.entry.url,
      });
    }
  }
  response(entry, response, extra) {
    entry.status = response.status;
    entry.mimeType = response.mimeType;
    entry.extraExpected = extra;
    if (this.options.details) entry.details.responseHeaders = response.headers;
  }
  finalize() {
    for (const chain of this.streams.values()) {
      let requestIndex = 0,
        responseIndex = 0;
      for (const hop of chain.hops) {
        if (!this.options.details) {
          delete hop.extraExpected;
          continue;
        }
        if (hop.extraExpected === false) {
          hop.details.extraInfoComplete = true;
        } else {
          // Extra-info events are ordered per (session, requestId), including redirects.
          // Consume request evidence even for a final failed/unfinished hop whose response
          // never arrived; otherwise its Cookie header would be left unassociated.
          const request = chain.requestExtras[requestIndex++];
          const response =
            hop.status !== undefined
              ? chain.responseExtras[responseIndex++]
              : undefined;
          if (request) {
            hop.details.extraRequestHeaders = request.headers;
            hop.details.associatedCookies = request.associatedCookies;
          }
          if (response) {
            hop.details.extraResponseHeaders = response.headers;
            hop.details.extraResponseStatusCode = response.statusCode;
            hop.details.blockedCookies = response.blockedCookies;
          }
          hop.details.extraInfoComplete =
            !!request && (hop.status === undefined ? false : !!response);
        }
        delete hop.extraExpected;
        if (
          hop.details.hasPostData &&
          hop.details.postData === undefined &&
          !hop.details.postDataError
        )
          hop.details.postDataError = "POST body unavailable";
      }
      // Preserve unmatched evidence rather than guessing which redirect hop owns it.
      if (
        this.options.details &&
        (requestIndex < chain.requestExtras.length ||
          responseIndex < chain.responseExtras.length)
      ) {
        this.entries.push({
          kind: "unmatched-extra-info",
          sessionId: chain.hops[0]?.sessionId,
          url: chain.hops[0]?.url,
          details: {
            request: chain.requestExtras.slice(requestIndex),
            response: chain.responseExtras.slice(responseIndex),
          },
        });
      }
    }
    const pattern = this.options.pattern?.toLowerCase();
    return this.entries.filter(
      (entry) =>
        (entry.kind === "unmatched-extra-info" ||
          (this.options.details && entry.kind === "request") ||
          isInteresting(entry, this.options.all)) &&
        (!pattern ||
          `${entry.url || ""} ${entry.text || ""}`
            .toLowerCase()
            .includes(pattern)),
    );
  }
}
export function formatEntry(entry, showMessages = false) {
  if (entry.kind === "request")
    return `${entry.method} ${entry.status ?? "pending"} ${entry.resourceType || "?"} ${safeUrl(entry.url)}${entry.errorText ? ` FAIL ${entry.errorText}` : ""}${entry.finished ? "" : " (unfinished at capture end)"}`;
  if (entry.kind === "unmatched-extra-info")
    return "Unmatched extra-info stored: header association incomplete";
  return `${entry.kind}.${entry.level || "error"}: ${showMessages ? (entry.text || "").replace(/\s+/g, " ").slice(0, 240) : "message stored in log (use --show-messages only if safe)"}`;
}
/** A bounded rolling byte buffer; includes stderr without ever forwarding it into the transcript. */
export async function runCommand(
  command,
  timeoutMs,
  environment = process.env,
) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      detached: true,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = Buffer.alloc(0),
      totalBytes = 0,
      timedOut = false,
      signalCode,
      killer;
    const signalGroup = (signal) => {
      if (child.pid) {
        try {
          process.kill(-child.pid, signal);
        } catch {}
      }
    };
    const terminate = () => {
      signalGroup("SIGTERM");
      killer ||= setTimeout(() => signalGroup("SIGKILL"), 300);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    const interrupt = () => {
      signalCode = 130;
      terminate();
    };
    const terminateSignal = () => {
      signalCode = 143;
      terminate();
    };
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", terminateSignal);
    const capture = (chunk) => {
      totalBytes += chunk.length;
      output = Buffer.concat([output, chunk.subarray(-16384)]).subarray(-16384);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    const cleanup = () => {
      clearTimeout(timer);
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminateSignal);
    };
    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.on("close", (code, signal) => {
      cleanup();
      // Leave a scheduled SIGKILL alive until it has killed descendants that ignored SIGTERM.
      resolve({
        code: timedOut ? 124 : signalCode || code || (signal ? 1 : 0),
        timedOut,
        output: output.toString("utf8"),
        droppedBytes: Math.max(0, totalBytes - output.length),
      });
    });
  });
}
const events = [
  "Network.requestWillBeSent",
  "Network.requestWillBeSentExtraInfo",
  "Network.responseReceived",
  "Network.responseReceivedExtraInfo",
  "Network.loadingFinished",
  "Network.loadingFailed",
  "Runtime.consoleAPICalled",
  "Runtime.exceptionThrown",
  "Log.entryAdded",
];
export async function runTrace(options) {
  return withLock("trace", async (traceToken) => {
    const cdp = await Cdp.open();
    const recorder = new Recorder(options, (sessionId, requestId) =>
      cdp.send("Network.getRequestPostData", { requestId }, sessionId, 2000),
    );
    const sessions = new Set(),
      off = [],
      setupWarnings = [],
      newTargets = new Set();
    const initialTargets = new Set();
    let pages,
      ran,
      captureReady = false;
    try {
      await withLock(
        "action",
        async () => {
          off.push(
            cdp.on("Target.targetCreated", ({ targetInfo }) => {
              if (
                captureReady &&
                targetInfo?.type === "page" &&
                !initialTargets.has(targetInfo.targetId)
              )
                newTargets.add(targetInfo.targetId);
            }),
          );
          await cdp.send("Target.setDiscoverTargets", { discover: true });
          const allPages = await listPageTargets(cdp);
          for (const page of allPages) initialTargets.add(page.targetId);
          pages = options.allTabs
            ? allPages
            : [selectPageTarget(allPages, options.tab).target];
          for (const event of events)
            off.push(
              cdp.on(event, (params, sessionId) => {
                if (sessions.has(sessionId))
                  recorder.accept(event, params, sessionId);
              }),
            );
          for (const page of pages) {
            const sessionId = await attach(cdp, page.targetId);
            sessions.add(sessionId);
            // Subscribe BEFORE enabling domains; Runtime/Log may replay buffered events.
            await cdp.send(
              "Network.enable",
              { maxPostDataSize: 1000000 },
              sessionId,
            );
            for (const domain of ["Runtime.enable", "Log.enable"]) {
              try {
                await cdp.send(domain, {}, sessionId);
              } catch (error) {
                setupWarnings.push(`${domain}: ${error.message}`);
              }
            }
          }
        },
        traceToken,
      );
      captureReady = true;
      if (options.run)
        ran = await runCommand(options.run, options.timeoutMs, {
          ...process.env,
          BROWSER_TRACE_TOKEN: traceToken,
        });
      else await sleep(options.seconds * 1000);
      await sleep(options.settleMs);
      for (const remove of off) remove();
      recorder.stopped = true;
      await Promise.allSettled([...recorder.pending]);
      const kept = recorder.finalize();
      if (newTargets.size)
        setupWarnings.push(
          `${newTargets.size} new tab(s)/popup(s) were outside the capture scope; open them before tracing`,
        );
      const out = options.out || artifactPath("trace", "ndjson");
      const meta = {
        kind: "capture",
        startedTabs: pages.map((page) => ({
          tab: page.tab,
          targetId: page.targetId,
        })),
        scope:
          "existing tabs only; new tabs/popups and worker/OOPIF targets not captured",
        details: options.details,
        protocolEvents: recorder.eventCount,
        droppedEvents: recorder.dropped,
        warnings: setupWarnings,
        ...(ran
          ? { commandExitCode: ran.code, commandTimedOut: ran.timedOut }
          : {}),
      };
      const file = privateWrite(
        out,
        [meta, ...kept].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
      );
      let childLog;
      if (ran)
        childLog = privateWrite(
          `${file}.command.log`,
          `${ran.droppedBytes ? `[${ran.droppedBytes} earlier bytes discarded]\n` : ""}${ran.output}`,
        );
      const requests = recorder.entries.filter(
        (entry) => entry.kind === "request",
      );
      const summary = [
        `log: ${file}${options.details ? " (sensitive: headers/cookies/POST bodies)" : ""}`,
        `scope: existing tab(s) ${pages.map((page) => page.tab).join(", ")}; new tabs/popups/workers/OOPIFs not captured`,
        `recorded ${requests.length} request hops; kept ${kept.length} records`,
        ...(recorder.dropped
          ? [
              `INCOMPLETE: ${recorder.dropped} protocol events dropped at capture budget`,
            ]
          : []),
        ...setupWarnings.map((warning) => `INCOMPLETE: ${warning}`),
        ...(ran
          ? [
              `command exited ${ran.code}${ran.timedOut ? " (timeout; process group terminated)" : ""}; output tail: ${childLog}`,
            ]
          : []),
        ...kept.map((entry) => formatEntry(entry, options.showMessages)),
      ].join("\n");
      return {
        summary: compact(summary, options.maxChars),
        code: ran?.code ?? 0,
        file,
      };
    } finally {
      for (const remove of off) remove();
      cdp.close();
    }
  });
}
export async function main(argv, maxChars = 6000) {
  if (helpRequested(argv)) return usage;
  const result = await runTrace({ ...parseTraceArgs(argv), maxChars });
  process.exitCode = result.code;
  return result.summary;
}
if (isMain(import.meta.url)) await cli(main);
