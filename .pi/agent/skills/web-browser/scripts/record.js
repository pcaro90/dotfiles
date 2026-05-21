#!/usr/bin/env node

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { connect } from "./cdp.js";

const RECORD_ROOT = join(homedir(), ".cache", "agent-web", "records");

function printUsage() {
  console.log("Usage: record.js [--timeout <seconds>] [--output <file>]");
  console.log("");
  console.log("Records full request data from the active tab using CDP.");
  console.log("");
  console.log("Options:");
  console.log("  --timeout <seconds>  Stop automatically after N seconds (default: 60)");
  console.log("  --output <file>      Write JSONL output to this file");
  console.log("  --help               Show this help");
  console.log("");
  console.log("Examples:");
  console.log("  record.js --timeout 30");
  console.log("  record.js --output /tmp/login-record.jsonl");
}

function parseArgs(argv) {
  const options = {
    timeoutSeconds: 60,
    output: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--help") {
      printUsage();
      process.exit(0);
    }

    if (arg === "--timeout") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--timeout requires a number of seconds");
      }
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error("--timeout must be a positive number");
      }
      options.timeoutSeconds = parsed;
      i += 1;
      continue;
    }

    if (arg === "--output") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--output requires a file path");
      }
      options.output = resolve(value);
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function ensureDir(dir) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function getDateDir() {
  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return join(RECORD_ROOT, `${yyyy}-${mm}-${dd}`);
}

function defaultOutputPath() {
  const dateDir = getDateDir();
  ensureDir(dateDir);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(dateDir, `record-${timestamp}.jsonl`);
}

function normalizeHeaders(headers) {
  if (!headers || typeof headers !== "object") return null;
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, String(value)]),
  );
}

function compactInitiator(initiator) {
  if (!initiator || typeof initiator !== "object") return null;
  const out = {
    type: initiator.type || null,
    url: initiator.url || null,
    lineNumber: initiator.lineNumber ?? null,
    columnNumber: initiator.columnNumber ?? null,
  };
  if (initiator.stack?.callFrames) {
    out.stack = initiator.stack.callFrames.slice(0, 5).map((frame) => ({
      functionName: frame.functionName || null,
      url: frame.url || null,
      lineNumber: frame.lineNumber,
      columnNumber: frame.columnNumber,
    }));
  }
  return out;
}

function valueContains(value, patterns) {
  if (value == null) return false;
  const text = String(value).toLowerCase();
  return patterns.some((pattern) => text.includes(pattern));
}

function headerValue(headers, name) {
  if (!headers) return null;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return null;
}

function scoreLoginCandidate(record) {
  let score = 0;
  const reasons = [];
  const url = record.url || "";
  const method = record.method || "";
  const postData = record.postData || "";
  const contentType =
    headerValue(record.extraRequestHeaders, "content-type") ||
    headerValue(record.requestHeaders, "content-type") ||
    "";
  const status = record.response?.status ?? record.extraResponseStatusCode;

  if (method === "POST") {
    score += 10;
    reasons.push("POST");
  }

  if (valueContains(url, ["login", "signin", "auth", "session", "token", "oauth"])) {
    score += 8;
    reasons.push("auth-like URL");
  }

  if (valueContains(postData, ["password", "passwd", "pwd", "username", "email", "csrf", "token"])) {
    score += 10;
    reasons.push("credential-like body");
  }

  if (valueContains(contentType, ["application/json", "application/x-www-form-urlencoded", "multipart/form-data"])) {
    score += 3;
    reasons.push("form/json content-type");
  }

  if ([200, 201, 204, 302, 303].includes(Number(status))) {
    score += 3;
    reasons.push(`status ${status}`);
  }

  if (["Fetch", "XHR", "Document"].includes(record.resourceType)) {
    score += 2;
    reasons.push(record.resourceType);
  }

  return { score, reasons };
}

function summarizeRecord(record) {
  const contentType =
    headerValue(record.extraRequestHeaders, "content-type") ||
    headerValue(record.requestHeaders, "content-type") ||
    null;
  const status = record.response?.status ?? record.extraResponseStatusCode ?? "unknown";
  const bodyPreview = record.postData
    ? record.postData.length > 180
      ? `${record.postData.slice(0, 180)}...`
      : record.postData
    : null;

  return {
    method: record.method,
    url: record.url,
    status,
    resourceType: record.resourceType,
    contentType,
    bodyPreview,
  };
}

function writeJsonl(outputPath, records) {
  ensureDir(dirname(outputPath));
  const lines = records.map((record) => JSON.stringify({
    type: "recorded.request",
    recordedAt: new Date().toISOString(),
    ...record,
  }));
  writeFileSync(outputPath, `${lines.join("\n")}${lines.length ? "\n" : ""}`);
}

const options = (() => {
  try {
    return parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error("✗", e.message);
    printUsage();
    process.exit(1);
  }
})();

const outputPath = options.output || defaultOutputPath();
const records = new Map();
const requestCounts = new Map();
const activeRequestKeys = new Map();
const pendingExtraRequestInfo = new Map();
const pendingExtraResponseInfo = new Map();
const pendingPostDataReads = new Set();

let cdp = null;
let stopped = false;
let stopResolve = null;
let targetId = null;
let sessionId = null;

function nextRequestKey(requestId) {
  const count = (requestCounts.get(requestId) || 0) + 1;
  requestCounts.set(requestId, count);
  const key = `${requestId}:${count}`;
  activeRequestKeys.set(requestId, key);
  return key;
}

function currentRecord(requestId) {
  const key = activeRequestKeys.get(requestId);
  if (!key) return null;
  return records.get(key) || null;
}

function applyPendingInfo(requestId, record) {
  const extraRequest = pendingExtraRequestInfo.get(requestId);
  if (extraRequest) {
    record.extraRequestHeaders = normalizeHeaders(extraRequest.headers);
    record.associatedCookies = extraRequest.associatedCookies || null;
    record.connectTiming = extraRequest.connectTiming || null;
    pendingExtraRequestInfo.delete(requestId);
  }

  const extraResponse = pendingExtraResponseInfo.get(requestId);
  if (extraResponse) {
    record.extraResponseHeaders = normalizeHeaders(extraResponse.headers);
    record.extraResponseStatusCode = extraResponse.statusCode ?? null;
    record.blockedCookies = extraResponse.blockedCookies || null;
    pendingExtraResponseInfo.delete(requestId);
  }
}

function readPostDataLater(requestId, record) {
  const promise = cdp
    .send("Network.getRequestPostData", { requestId }, sessionId, 5000)
    .then((result) => {
      if (result?.postData && !record.postData) {
        record.postData = result.postData;
        record.postDataSource = "Network.getRequestPostData";
      }
    })
    .catch((e) => {
      record.postDataError = e.message;
    })
    .finally(() => {
      pendingPostDataReads.delete(promise);
    });

  pendingPostDataReads.add(promise);
}

async function waitForStop() {
  return new Promise((resolveStop) => {
    stopResolve = resolveStop;
  });
}

function requestStop(reason) {
  if (stopped) return;
  stopped = true;
  if (reason) console.error(`○ stopping recorder: ${reason}`);
  if (stopResolve) stopResolve();
}

async function finish() {
  if (pendingPostDataReads.size > 0) {
    await Promise.allSettled([...pendingPostDataReads]);
  }

  const allRecords = [...records.values()].sort((a, b) => {
    const at = a.wallTime || a.timestamp || 0;
    const bt = b.wallTime || b.timestamp || 0;
    return at - bt;
  });

  writeJsonl(outputPath, allRecords);

  console.log(`✓ recorded ${allRecords.length} request(s)`);
  console.log(`  output: ${outputPath}`);

  const candidates = allRecords
    .map((record) => ({ record, ...scoreLoginCandidate(record) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  if (candidates.length > 0) {
    console.log("");
    console.log("Likely login/auth candidates:");
    candidates.forEach((item, index) => {
      const summary = summarizeRecord(item.record);
      console.log(``);
      console.log(`[${index + 1}] score ${item.score} (${item.reasons.join(", ")})`);
      console.log(`    ${summary.method} ${summary.url}`);
      console.log(`    status: ${summary.status}`);
      if (summary.resourceType) console.log(`    resourceType: ${summary.resourceType}`);
      if (summary.contentType) console.log(`    content-type: ${summary.contentType}`);
      if (summary.bodyPreview) console.log(`    body: ${summary.bodyPreview}`);
      console.log(`    requestId: ${item.record.requestId}`);
    });
  }

  console.log("");
  console.log("Search recorded requests with:");
  console.log(`  ./scripts/search-recorded-request.js login --file ${JSON.stringify(outputPath)}`);
  console.log(`  ./scripts/search-recorded-request.js password --file ${JSON.stringify(outputPath)} --json`);
}

process.on("SIGINT", () => requestStop("SIGINT"));
process.on("SIGTERM", () => requestStop("SIGTERM"));

try {
  console.error("⚠ recording full request headers and bodies from the active tab");
  console.error(`○ timeout: ${options.timeoutSeconds}s`);

  cdp = await connect(5000);
  const pages = await cdp.getPages();
  const page = pages.at(-1);

  if (!page) {
    throw new Error("No active tab found");
  }

  targetId = page.targetId;
  sessionId = await cdp.attachToPage(targetId);

  await cdp.send("Network.enable", {
    maxTotalBufferSize: 100_000_000,
    maxResourceBufferSize: 10_000_000,
    maxPostDataSize: 10_000_000,
  }, sessionId);
  await cdp.send("Page.enable", {}, sessionId);

  cdp.on("Network.requestWillBeSent", (params, eventSessionId) => {
    if (eventSessionId !== sessionId) return;

    const request = params.request || {};
    const key = nextRequestKey(params.requestId);
    const record = {
      requestKey: key,
      requestId: params.requestId,
      loaderId: params.loaderId || null,
      timestamp: params.timestamp ?? null,
      wallTime: params.wallTime ?? null,
      documentURL: params.documentURL || null,
      resourceType: params.type || null,
      frameId: params.frameId || null,
      initiator: compactInitiator(params.initiator),
      method: request.method || null,
      url: request.url || null,
      requestHeaders: normalizeHeaders(request.headers),
      hasPostData: !!request.hasPostData,
      postData: request.postData || null,
      postDataSource: request.postData ? "Network.requestWillBeSent" : null,
      mixedContentType: request.mixedContentType || null,
      initialPriority: request.initialPriority || null,
      referrerPolicy: request.referrerPolicy || null,
      redirectResponse: params.redirectResponse
        ? {
            url: params.redirectResponse.url || null,
            status: params.redirectResponse.status,
            statusText: params.redirectResponse.statusText || null,
            headers: normalizeHeaders(params.redirectResponse.headers),
          }
        : null,
      response: null,
      failed: null,
      finished: false,
    };

    records.set(key, record);
    applyPendingInfo(params.requestId, record);

    if (record.hasPostData && !record.postData) {
      readPostDataLater(params.requestId, record);
    }
  });

  cdp.on("Network.requestWillBeSentExtraInfo", (params, eventSessionId) => {
    if (eventSessionId !== sessionId) return;
    const record = currentRecord(params.requestId);
    if (!record) {
      pendingExtraRequestInfo.set(params.requestId, params);
      return;
    }
    record.extraRequestHeaders = normalizeHeaders(params.headers);
    record.associatedCookies = params.associatedCookies || null;
    record.connectTiming = params.connectTiming || null;
  });

  cdp.on("Network.responseReceived", (params, eventSessionId) => {
    if (eventSessionId !== sessionId) return;
    const record = currentRecord(params.requestId);
    if (!record) return;
    const response = params.response || {};
    record.response = {
      url: response.url || null,
      status: response.status,
      statusText: response.statusText || null,
      headers: normalizeHeaders(response.headers),
      mimeType: response.mimeType || null,
      charset: response.charset || null,
      remoteIPAddress: response.remoteIPAddress || null,
      remotePort: response.remotePort ?? null,
      fromDiskCache: !!response.fromDiskCache,
      fromServiceWorker: !!response.fromServiceWorker,
      encodedDataLength: response.encodedDataLength ?? null,
    };
  });

  cdp.on("Network.responseReceivedExtraInfo", (params, eventSessionId) => {
    if (eventSessionId !== sessionId) return;
    const record = currentRecord(params.requestId);
    if (!record) {
      pendingExtraResponseInfo.set(params.requestId, params);
      return;
    }
    record.extraResponseHeaders = normalizeHeaders(params.headers);
    record.extraResponseStatusCode = params.statusCode ?? null;
    record.blockedCookies = params.blockedCookies || null;
  });

  cdp.on("Network.loadingFinished", (params, eventSessionId) => {
    if (eventSessionId !== sessionId) return;
    const record = currentRecord(params.requestId);
    if (!record) return;
    record.finished = true;
    record.finishedAt = params.timestamp ?? null;
    record.encodedDataLength = params.encodedDataLength ?? null;
  });

  cdp.on("Network.loadingFailed", (params, eventSessionId) => {
    if (eventSessionId !== sessionId) return;
    const record = currentRecord(params.requestId);
    if (!record) return;
    record.finished = true;
    record.failed = {
      timestamp: params.timestamp ?? null,
      errorText: params.errorText || null,
      canceled: !!params.canceled,
      blockedReason: params.blockedReason || null,
      corsErrorStatus: params.corsErrorStatus || null,
    };
  });

  console.error(`✓ recording active tab: ${page.url || targetId}`);

  const timer = setTimeout(() => requestStop("timeout"), options.timeoutSeconds * 1000);
  await waitForStop();
  clearTimeout(timer);

  await finish();

  cdp.close();
  setTimeout(() => process.exit(0), 100);
} catch (e) {
  if (cdp) {
    try {
      cdp.close();
    } catch {
      // ignore
    }
  }
  console.error("✗ record failed:", e.message);
  process.exit(1);
}
