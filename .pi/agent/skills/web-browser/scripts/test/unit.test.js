import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  Cdp,
  compact,
  debugPort,
  normalizeUrl,
  privateWrite,
  readStateRecord,
  selectPageTarget,
  withLock,
  wrapJavaScript,
} from "../shared.js";
import { resolveDevice, deviceArgs, applyDevice } from "../devices.js";
import { parseStartArgs, chromeArguments } from "../session.js";
import { parseNavArgs } from "../nav.js";
import { navigate, readiness } from "../page.js";
import { parseReadArgs, formatRead } from "../read.js";
import { keyDescriptor, parseActArgs, sendKey } from "../act.js";
import { parseShotArgs, elementClip } from "../shot.js";
import { Recorder, parseTraceArgs, runCommand, formatEntry } from "../trace.js";

function fakeCdp() {
  const handlers = new Map(),
    calls = [];
  return {
    calls,
    async send(method, params, sessionId) {
      calls.push({ method, params, sessionId });
      return {};
    },
    on(method, handler) {
      const set = handlers.get(method) || new Set();
      handlers.set(method, set);
      set.add(handler);
      return () => set.delete(handler);
    },
    emit(method, params = {}, sessionId = "one") {
      for (const handler of handlers.get(method) || [])
        handler(params, sessionId);
    },
  };
}
test("all output stays within budget including the continuation notice", () => {
  for (const limit of [1, 128, 6000]) {
    const text = compact("x".repeat(100000), limit);
    assert.ok(text.length <= limit);
  }
  assert.match(compact("x".repeat(1000), 128), /truncated/);
  const options = parseReadArgs(["--links", "--max-chars", "128"]);
  const result = formatRead(
    [{ href: "https://x/" + "x".repeat(100000) }],
    options,
  );
  assert.ok(result.body.length <= 128);
  assert.ok(result.full.length > 100000);
});
test("statements AND await expressions compile in an async context", async () => {
  for (const source of [
    "await Promise.resolve(42)",
    "const n=await Promise.resolve(41); return n+1",
  ]) {
    assert.equal(await eval(wrapJavaScript(source).expression), 42);
  }
  assert.throws(() => wrapJavaScript("const }"), /Invalid JavaScript/);
});
test("URLs and start arguments validate dangerous or malformed inputs", () => {
  assert.equal(normalizeUrl("localhost:8787"), "http://localhost:8787/");
  assert.equal(normalizeUrl("example.com/docs"), "https://example.com/docs");
  assert.throws(() => normalizeUrl("javascript:alert(1)"), /Only http/);
  assert.throws(() => normalizeUrl("file:///tmp/page"), /Only http/);
  assert.throws(() => debugPort({ BROWSER_DEBUG_PORT: "0" }), /between/);
  assert.equal(parseStartArgs([], {}).headless, true);
  assert.throws(
    () => parseStartArgs(["--profile-source", "/tmp/x"], {}),
    /requires --profile/,
  );
});
test("sandbox and loopback default on; sandbox override is explicit", () => {
  const args = chromeArguments(parseStartArgs([], {}), "/tmp/profile");
  assert.ok(args.includes("--remote-debugging-address=127.0.0.1"));
  assert.ok(!args.includes("--no-sandbox"));
  assert.ok(
    chromeArguments(
      parseStartArgs(["--no-sandbox"], {}),
      "/tmp/profile",
    ).includes("--no-sandbox"),
  );
});
test("mobile and responsive are different models; desktop resets all overrides", async () => {
  assert.equal(resolveDevice("pixel-8").mode, "mobile");
  assert.equal(deviceArgs(["--viewport", "412x915"]).device.mode, "responsive");
  assert.throws(() => resolveDevice("99999x1"), /dimensions/);
  assert.throws(
    () => deviceArgs(["--device", "none", "--viewport", "400x800"]),
    /only one/,
  );
  const cdp = fakeCdp();
  await applyDevice(cdp, "one", resolveDevice("pixel-8"));
  assert.equal(cdp.calls[0].params.mobile, true);
  await applyDevice(cdp, "one", null);
  assert.equal(cdp.calls[3].params.mobile, false);
  assert.equal(cdp.calls[4].params.enabled, false);
  assert.deepEqual(cdp.calls[5].params, { userAgent: "", platform: "" });
});
test("tab numbers are identifiers, not array indices; closed numbers are rejected", () => {
  const pages = [
    { tab: 3, targetId: "a" },
    { tab: 8, targetId: "b" },
  ];
  assert.equal(selectPageTarget(pages, 8, "a").target.targetId, "b");
  assert.equal(selectPageTarget(pages, "a", "b").tab, 3);
  assert.equal(selectPageTarget(pages, undefined, "a").tab, 3);
  assert.throws(() => selectPageTarget(pages, 1, "a"), /does not exist/);
});
test("navigation waits for matching loader and session, with listener installed before navigate", async () => {
  const cdp = fakeCdp();
  let done = false;
  cdp.send = async (method) => {
    if (method === "Page.navigate") {
      cdp.emit("Page.lifecycleEvent", { loaderId: "old", name: "load" });
      cdp.emit(
        "Page.lifecycleEvent",
        { loaderId: "new", name: "load" },
        "other",
      );
      return { loaderId: "new" };
    }
    return {};
  };
  const pending = navigate(cdp, "one", {
    url: "https://example.com",
    wait: "load",
    timeoutMs: 1000,
  }).then(() => {
    done = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(done, false);
  cdp.emit("Page.lifecycleEvent", { loaderId: "new", name: "load" });
  await pending;
  assert.equal(done, true);
});
test("navigation sees events emitted before the acknowledgment and reports errorText", async () => {
  const cdp = fakeCdp();
  cdp.send = async (method) => {
    if (method === "Page.navigate") {
      cdp.emit("Page.lifecycleEvent", { loaderId: "n", name: "load" });
      return { loaderId: "n" };
    }
    return {};
  };
  await navigate(cdp, "one", {
    url: "https://example.com",
    wait: "load",
    timeoutMs: 100,
  });
  cdp.send = async () => ({ errorText: "net::ERR_CONNECTION_REFUSED" });
  await assert.rejects(
    navigate(cdp, "one", {
      url: "https://example.com",
      wait: "load",
      timeoutMs: 100,
    }),
    /ERR_CONNECTION_REFUSED/,
  );
});
test("action readiness is cancellable, scoped, and times out honestly", async () => {
  const cdp = fakeCdp();
  const waiting = readiness(cdp, "one", "load", 30);
  cdp.emit("Page.loadEventFired", {}, "other");
  await assert.rejects(waiting.promise, /Timed out/);
  waiting.cancel();
  const cancelled = readiness(cdp, "one", "load", 10000);
  cancelled.cancel();
});
test("parser edge cases and keyboard text avoid accidental shortcut insertion", async () => {
  assert.throws(
    () => parseNavArgs(["example.com", "--new", "--tab", "1"]),
    /not both/,
  );
  assert.throws(
    () => parseNavArgs(["example.com", "--timeout", "0"]),
    /between/,
  );
  assert.throws(() => parseReadArgs(["--forms", "--html"]), /one read mode/);
  assert.throws(() => parseActArgs(["scroll", "--delta", "NaN"]), /integer/);
  assert.equal(parseActArgs(["scroll"]).target, undefined);
  assert.throws(
    () => parseActArgs(["check", "--target", "#a", "--text", "yes"]),
    /true or false/,
  );
  assert.equal(parseActArgs(["consent"]).accept, false);
  assert.equal(keyDescriptor("Enter").text, "\r");
  assert.equal(keyDescriptor("😀").text, "😀");
  const cdp = fakeCdp();
  await sendKey({ cdp, sessionId: "one" }, keyDescriptor("a"), 2);
  assert.equal(cdp.calls[0].params.text, undefined);
});
test("screenshots reject contradictory, hidden, and huge invalid regions", () => {
  assert.throws(
    () => parseShotArgs(["--full-page", "--selector", "#a"]),
    /not both/,
  );
  assert.throws(
    () => elementClip({ width: 0, height: 10 }, {}, { width: 10, height: 10 }),
    /hidden/,
  );
  assert.deepEqual(
    elementClip(
      { x: 5, y: 10, width: 50, height: 60 },
      { x: 0, y: 100 },
      { width: 100, height: 200 },
    ),
    { x: 5, y: 110, width: 50, height: 60, scale: 1 },
  );
});
test("private outputs enforce permissions and refuse symlinks", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "browser-unit-"));
  try {
    const file = path.join(dir, "out");
    writeFileSync(file, "old", { mode: 0o644 });
    privateWrite(file, "new");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    symlinkSync(file, path.join(dir, "link"));
    assert.throws(() => privateWrite(path.join(dir, "link"), "bad"));
    assert.equal(readFileSync(file, "utf8"), "new");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("foreground lock rejects overlap and is released on exceptions", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "browser-lock-")),
    old = process.env.BROWSER_HOME;
  process.env.BROWSER_HOME = dir;
  try {
    await withLock("action", async () => {
      await assert.rejects(
        withLock("action", async () => {}),
        /Another action/,
      );
    });
    await assert.rejects(
      withLock("action", async () => {
        throw new Error("boom");
      }),
      /boom/,
    );
    await withLock("action", async () => {});
    assert.deepEqual(readStateRecord(), {});
  } finally {
    if (old === undefined) delete process.env.BROWSER_HOME;
    else process.env.BROWSER_HOME = old;
    rmSync(dir, { recursive: true, force: true });
  }
});
test("CDP disconnect rejects pending calls without waiting for their timers", async () => {
  const listeners = new Map();
  const socket = {
    send() {},
    close() {},
    addEventListener(name, callback) {
      listeners.set(name, callback);
    },
  };
  const cdp = new Cdp(socket),
    pending = cdp.send("Test", {}, undefined, 10000);
  listeners.get("close")();
  await assert.rejects(pending, /disconnected/);
});
function recordFixture(options = {}) {
  return new Recorder({ ...parseTraceArgs([]), details: true, ...options });
}
const req = (url, method = "POST") => ({
  requestId: "r",
  type: "Fetch",
  request: {
    method,
    url,
    headers: {},
    hasPostData: method === "POST",
    ...(method === "POST" ? { postData: "DUMMY_BODY" } : {}),
  },
});
test("details retains request bodies without --all and captures extra Cookie headers", () => {
  const recorder = recordFixture();
  recorder.accept(
    "Network.requestWillBeSentExtraInfo",
    {
      requestId: "r",
      headers: { Cookie: "DUMMY_COOKIE" },
      associatedCookies: [],
    },
    "s",
  );
  recorder.accept(
    "Network.requestWillBeSent",
    req("https://example.com/login"),
    "s",
  );
  recorder.accept(
    "Network.responseReceivedExtraInfo",
    { requestId: "r", headers: {}, statusCode: 200 },
    "s",
  );
  recorder.accept(
    "Network.responseReceived",
    {
      requestId: "r",
      hasExtraInfo: true,
      response: { status: 200, headers: {} },
    },
    "s",
  );
  const [entry] = recorder.finalize();
  assert.equal(entry.details.postData, "DUMMY_BODY");
  assert.equal(entry.details.extraRequestHeaders.Cookie, "DUMMY_COOKIE");
  assert.equal(entry.details.extraInfoComplete, true);
  assert.ok(!formatEntry(entry).includes("DUMMY"));
  const unusual = recordFixture();
  unusual.accept(
    "Network.requestWillBeSent",
    { ...req("https://example.com/beacon"), type: "Other" },
    "s",
  );
  assert.equal(
    unusual.finalize().length,
    1,
    "--details retains non-Fetch requests too",
  );
});
test("redirect hops correlate extra-info by order even when it arrives before/after base events", () => {
  const recorder = recordFixture();
  recorder.accept(
    "Network.requestWillBeSent",
    req("https://example.com/login"),
    "s",
  );
  recorder.accept(
    "Network.requestWillBeSent",
    {
      ...req("https://example.com/home", "GET"),
      redirectHasExtraInfo: true,
      redirectResponse: { status: 303, headers: { Location: "/home" } },
    },
    "s",
  );
  for (const cookie of ["first", "second"])
    recorder.accept(
      "Network.requestWillBeSentExtraInfo",
      { requestId: "r", headers: { Cookie: cookie } },
      "s",
    );
  for (const status of [303, 200])
    recorder.accept(
      "Network.responseReceivedExtraInfo",
      {
        requestId: "r",
        headers: { "X-Hop": String(status) },
        statusCode: status,
      },
      "s",
    );
  recorder.accept(
    "Network.responseReceived",
    {
      requestId: "r",
      hasExtraInfo: true,
      response: { status: 200, headers: {} },
    },
    "s",
  );
  const records = recorder.finalize();
  assert.equal(records.length, 2);
  assert.equal(records[0].details.extraRequestHeaders.Cookie, "first");
  assert.equal(records[1].details.extraRequestHeaders.Cookie, "second");
  assert.equal(records[0].details.extraResponseStatusCode, 303);
  assert.equal(records[1].details.extraResponseStatusCode, 200);
});
test("a failed final redirect hop keeps its request extra-info instead of orphaning cookies", () => {
  const recorder = recordFixture();
  recorder.accept(
    "Network.requestWillBeSent",
    req("https://example.com/start"),
    "s",
  );
  recorder.accept(
    "Network.requestWillBeSent",
    {
      ...req("https://example.com/final", "GET"),
      redirectHasExtraInfo: true,
      redirectResponse: { status: 302, headers: {} },
    },
    "s",
  );
  recorder.accept(
    "Network.requestWillBeSentExtraInfo",
    { requestId: "r", headers: { Cookie: "first" } },
    "s",
  );
  recorder.accept(
    "Network.requestWillBeSentExtraInfo",
    { requestId: "r", headers: { Cookie: "final" } },
    "s",
  );
  recorder.accept(
    "Network.responseReceivedExtraInfo",
    { requestId: "r", headers: {}, statusCode: 302 },
    "s",
  );
  recorder.accept(
    "Network.loadingFailed",
    { requestId: "r", errorText: "net::ERR_FAILED" },
    "s",
  );
  const records = recorder.finalize();
  assert.equal(records[1].details.extraRequestHeaders.Cookie, "final");
  assert.equal(records[1].details.extraInfoComplete, false);
  assert.equal(records[1].errorText, "net::ERR_FAILED");
});
test("identical request IDs from different sessions do not collide", () => {
  const recorder = recordFixture();
  recorder.accept("Network.requestWillBeSent", req("https://a.test"), "a");
  recorder.accept("Network.requestWillBeSent", req("https://b.test"), "b");
  assert.equal(recorder.streams.size, 2);
  assert.equal(recorder.finalize().length, 2);
});
test("capture budgets are explicit and details are absent without opt-in", () => {
  const recorder = recordFixture({ maxEvents: 1, details: false });
  recorder.accept("Network.requestWillBeSent", req("https://a.test"), "a");
  recorder.accept("Network.requestWillBeSent", req("https://b.test"), "a");
  assert.equal(recorder.dropped, 1);
  assert.equal(recorder.finalize()[0].details, undefined);
  assert.throws(
    () => parseTraceArgs(["--run", "true", "--seconds", "5"]),
    /not both/,
  );
});
test("command capture is bounded, preserves failures, and kills timed-out process groups", async () => {
  const result = await runCommand(
    `${JSON.stringify(process.execPath)} -e 'process.stdout.write("x".repeat(100000));process.exitCode=7'`,
    3000,
  );
  assert.equal(result.code, 7);
  assert.ok(result.output.length <= 16384);
  assert.ok(result.droppedBytes > 0);
  const timeout = await runCommand("sleep 10", 100);
  assert.equal(timeout.code, 124);
  assert.equal(timeout.timedOut, true);
});
