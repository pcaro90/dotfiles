import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { findChromium } from "../session.js";
const execute = promisify(execFile);
const scripts = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const shellCommand = (script, args) =>
  [process.execPath, path.join(scripts, script), ...args].map(quote).join(" ");
const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const close = (server) =>
  new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(resolve);
  });

test(
  "real Chromium regressions (isolated profile, loopback, sandbox)",
  { timeout: 180000 },
  async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "agent-browser-integration-"));
    const home = path.join(root, "browser");
    const env = {
      ...process.env,
      BROWSER_HOME: home,
      BROWSER_BIN: process.env.BROWSER_TEST_BIN || findChromium(),
    };
    delete env.BROWSER_DEBUG_PORT;
    const received = [];
    const server = http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      received.push({
        url: req.url,
        method: req.method,
        body,
        cookie: req.headers.cookie,
      });
      if (req.url === "/echo") {
        res.setHeader("Content-Type", "application/json");
        res.end('{"ok":true}');
        return;
      }
      if (req.url === "/redirect") {
        res.writeHead(303, {
          Location: "/final",
          "Set-Cookie": "redirect_cookie=DUMMY_REDIRECT; Path=/",
        });
        res.end();
        return;
      }
      if (req.url === "/final") {
        res.end("redirect complete");
        return;
      }
      if (req.url === "/slow.png") {
        setTimeout(() => {
          res.writeHead(200, { "Content-Type": "image/png" });
          res.end(
            Buffer.from(
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
              "base64",
            ),
          );
        }, 350);
        return;
      }
      if (req.url === "/frame") {
        res.setHeader("Content-Type", "text/html");
        res.end(
          '<div id="cookie-banner"><button onclick="document.body.dataset.rejected=1;this.parentNode.remove()">Reject all cookies</button></div>',
        );
        return;
      }
      res.setHeader("Content-Type", "text/html");
      res.setHeader(
        "Set-Cookie",
        "session_cookie=DUMMY_COOKIE; Path=/; HttpOnly",
      );
      res.end(`<!doctype html><html><head>${req.url.startsWith("/no-meta") ? "" : '<meta name="viewport" content="width=device-width,initial-scale=1">'}<title>Local browser fixture</title></head><body>
      <h1>Fixture</h1><button id="book" onclick="window.booked=(window.booked||0)+1">Book appointment</button>
      <form id="form" method="post" action="/echo"><input id="email" name="email"><input id="password" name="password" type="password" value="DUMMY_PASSWORD"><input name="csrf" type="hidden" value="DUMMY_CSRF"><button id="submit">Submit</button></form>
      <input type="radio" name="color" value="r"><input type="radio" name="color" value="g"><input id="agree" type="checkbox">
      <input name='unusual"name' value="quoted name"><select id="country"><option value="es">Spain</option><option value="fr">France</option></select>
      <input id="file" type="file" hidden><div id="host"></div><button id="alert" onclick="alert('DUMMY_DIALOG');window.alertDone=true">Alert</button>
      <button id="confirm" onclick="window.confirmed=confirm('DUMMY_CONFIRM')">Confirm</button>
      ${req.url.startsWith("/iframe") ? '<iframe src="/frame"></iframe>' : ""}
      ${req.url.startsWith("/slow") ? '<img src="/slow.png">' : ""}
      <div id="large" style="height:2500px">Long page</div><a href="/echo">Echo link</a>
      <script>document.querySelector('#host').attachShadow({mode:'open'}).innerHTML='<input name="shadow" placeholder="Shadow input">';window.keyEvents=0;document.addEventListener('keydown',()=>window.keyEvents++);setTimeout(()=>{document.body.dataset.ready='yes'},100);</script>
      </body></html>`);
    });
    await listen(server);
    const url = `http://127.0.0.1:${server.address().port}`;
    const reserve = http.createServer();
    await listen(reserve);
    const port = reserve.address().port;
    await close(reserve);
    const run = async (script, args = [], extraEnv = {}) => {
      const result = await execute(
        process.execPath,
        [path.join(scripts, script), ...args],
        {
          env: { ...env, ...extraEnv },
          timeout: 35000,
          maxBuffer: 2 * 1024 * 1024,
        },
      );
      return result.stdout.trimEnd();
    };
    const expression = async (js, args = []) => {
      const output = await run("read.js", ["--expr", js, ...args]);
      return output.split("\n\n").slice(1).join("\n\n");
    };
    let started = false;
    try {
      const output = await run("session.js", ["start", "--port", String(port)]);
      started = true;
      assert.match(output, /sandbox enabled/);
      await t.test(
        "custom port persists and all commands reject unknown state/endpoint",
        async () => {
          assert.match(
            await run("session.js", ["status"]),
            new RegExp(String(port)),
          );
          assert.match(await run("session.js", ["start"]), /already running/);
          await assert.rejects(
            run("session.js", ["start", "--reset-profile"]),
            /Stop it before/,
          );
          await assert.rejects(
            run("session.js", ["start", "--port", String(port)], {
              BROWSER_HOME: path.join(root, "occupied"),
            }),
            /Port .* in use/,
          );
          const profileSource = path.join(root, "live-source-profile");
          // A live source lock must be rejected before rsync or Chrome launch.
          mkdirSync(profileSource);
          symlinkSync(
            `host-${process.pid}`,
            path.join(profileSource, "SingletonLock"),
          );
          const profilePortServer = http.createServer();
          await listen(profilePortServer);
          const profilePort = profilePortServer.address().port;
          await close(profilePortServer);
          await assert.rejects(
            run(
              "session.js",
              [
                "start",
                "--port",
                String(profilePort),
                "--profile",
                "--profile-source",
                profileSource,
              ],
              { BROWSER_HOME: path.join(root, "profile-copy-test") },
            ),
            /Source profile is in use/,
          );
          await assert.rejects(
            run("read.js", ["--expr", "document.title"], {
              BROWSER_HOME: path.join(root, "unowned"),
            }),
            /No verified managed Chrome/,
          );
          await assert.rejects(
            run("read.js", ["--expr", "document.title"], {
              BROWSER_DEBUG_PORT: String(port === 65535 ? 65534 : port + 1),
            }),
            /disagrees/,
          );
          const file = path.join(home, "session.json"),
            saved = readFileSync(file, "utf8"),
            state = JSON.parse(saved);
          state.webSocketDebuggerUrl += "wrong";
          writeFileSync(file, JSON.stringify(state));
          try {
            await assert.rejects(
              run("session.js", ["stop"]),
              /identity changed/,
            );
          } finally {
            writeFileSync(file, saved);
          }
        },
      );
      await t.test(
        "navigation waits for load, selectors and hash transitions",
        async () => {
          const start = Date.now();
          assert.match(await run("nav.js", [url + "/slow"]), /ready: complete/);
          assert.ok(Date.now() - start >= 350);
          assert.match(
            await run("nav.js", [url + "/slow#anchor"]),
            /same-document/,
          );
          assert.equal(await expression("location.hash"), "#anchor");
          await run("nav.js", [
            url + "/meta",
            "--wait",
            "none",
            "--until",
            '[data-ready="yes"]',
          ]);
          assert.equal(await expression("document.body.dataset.ready"), "yes");
          await assert.rejects(
            run("nav.js", [
              url + "/meta",
              "--wait",
              "none",
              "--until",
              "#absent",
              "--timeout",
              "1",
            ]),
            /Timed out/,
          );
        },
      );
      await t.test(
        "await, nested JSON and all text/list outputs are bounded",
        async () => {
          assert.equal(await expression("await Promise.resolve(42)"), "42");
          assert.equal(
            await expression(
              "const n=await Promise.resolve(40);return {n:n+2}",
            ),
            '{"n":42}',
          );
          await expression(
            '(()=>{document.querySelector("a").href="https://example.com/"+"x".repeat(100000);document.querySelector("#large").textContent="y".repeat(100000);return true})()',
          );
          for (const args of [
            ["--links"],
            ["--selector", "#large"],
            ["--expr", '"z".repeat(100000)'],
          ]) {
            const output = await run("read.js", [
              ...args,
              "--max-chars",
              "512",
            ]);
            assert.ok(output.length <= 512);
            assert.match(output, /truncated/);
          }
          const file = path.join(root, "page.txt");
          const output = await run("read.js", [
            "--selector",
            "#large",
            "--out",
            file,
          ]);
          assert.equal(readFileSync(file, "utf8").length, 100000);
          assert.ok(!output.includes("yyyy"));
          assert.equal(statSync(file).mode & 0o777, 0o600);
          const largeFrame = path.join(root, "five-megabytes.txt");
          await run("read.js", [
            "--expr",
            '"x".repeat(5*1024*1024)',
            "--out",
            largeFrame,
          ]);
          assert.equal(statSync(largeFrame).size, 5 * 1024 * 1024);
        },
      );
      await t.test(
        "form selectors uniquely identify radios, quote names and shadow inputs; secrets masked",
        async () => {
          await run("nav.js", [url + "/meta"]);
          const file = path.join(root, "forms.ndjson");
          await run("read.js", ["--forms", "--out", file]);
          const content = readFileSync(file, "utf8"),
            fields = content
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line));
          assert.ok(!content.includes("DUMMY_PASSWORD"));
          assert.ok(!content.includes("DUMMY_CSRF"));
          const radios = fields.filter((field) => field.type === "radio");
          assert.notEqual(radios[0].selector, radios[1].selector);
          await run("act.js", ["check", "--target", radios[1].selector]);
          assert.equal(
            await expression(
              'document.querySelectorAll("input[name=color]")[1].checked',
            ),
            "true",
          );
          const unusual = fields.find((field) => field.name.includes('"'));
          await run("act.js", [
            "type",
            "--target",
            unusual.selector,
            "--clear",
            "--text",
            "fixed",
          ]);
          const shadow = fields.find((field) => field.name === "shadow");
          assert.match(shadow.selector, />>>/);
          await run("act.js", [
            "type",
            "--target",
            shadow.selector,
            "--text",
            "shadow works",
          ]);
          assert.equal(
            await expression(
              'document.querySelector("#host").shadowRoot.querySelector("input").value',
            ),
            "shadow works",
          );
          assert.ok(
            !(await run("read.js", ["--html"])).includes("DUMMY_PASSWORD"),
          );
          assert.match(
            await run("read.js", ["--forms", "--show-values"]),
            /DUMMY_PASSWORD/,
          );
          await assert.rejects(
            run("act.js", ["click", "--target", "input[name=color]"]),
            /Ambiguous selector/,
          );
        },
      );
      await t.test(
        "real typing/keyboard, idempotent checks, select, hidden upload, scroll and covered targets",
        async () => {
          await run("act.js", [
            "type",
            "--target",
            "#email",
            "--text",
            "first",
          ]);
          await run("act.js", [
            "type",
            "--target",
            "#email",
            "--clear",
            "--slow",
            "--text",
            "second😀",
          ]);
          assert.equal(
            await expression('document.querySelector("#email").value'),
            "second😀",
          );
          assert.ok(Number(await expression("window.keyEvents")) > 0);
          await run("act.js", ["check", "--target", "#agree"]);
          assert.match(
            await run("act.js", ["check", "--target", "#agree"]),
            /already checked/,
          );
          await run("act.js", [
            "select",
            "--target",
            "#country",
            "--text",
            "France",
          ]);
          assert.equal(
            await expression('document.querySelector("#country").value'),
            "fr",
          );
          const file = path.join(root, "upload,with-comma.txt");
          writeFileSync(file, "dummy upload");
          await run("act.js", ["upload", "--target", "#file", "--file", file]);
          assert.equal(
            await expression('document.querySelector("#file").files[0].name'),
            "upload,with-comma.txt",
          );
          await assert.rejects(
            run("act.js", [
              "upload",
              "--target",
              "#file",
              "--file",
              file + "-missing",
            ]),
            /does not exist/,
          );
          await run("act.js", ["scroll", "--delta", "600"]);
          assert.ok(Number(await expression("scrollY")) > 0);
          await run("act.js", ["scroll", "--target", "#book"]);
          await expression(
            '(()=>{const el=document.createElement("div");el.id="cover";el.style="position:fixed;inset:0;z-index:9999";document.body.append(el);return true})()',
          );
          await assert.rejects(
            run("act.js", ["click", "--target", "#book"]),
            /covered/,
          );
          await expression('document.querySelector("#cover").remove()');
          await run("act.js", [
            "press",
            "--target",
            "#email",
            "--key",
            "Enter",
            "--wait",
            "load",
          ]);
          assert.ok(
            received.some(
              (request) =>
                request.method === "POST" &&
                request.url === "/echo" &&
                request.body.includes("second"),
            ),
          );
        },
      );
      await t.test(
        "consent cannot click Book appointment and supports arbitrary shadow hosts/frames",
        async () => {
          await run("nav.js", [url + "/meta"]);
          assert.match(
            await run("act.js", ["consent", "--accept"]),
            /No consent clicked/,
          );
          assert.equal(await expression("window.booked || 0"), "0");
          await expression(
            '(()=>{document.querySelector("#host").shadowRoot.innerHTML="<div id=\\"cookie-consent\\"><button onclick=\\"this.parentNode.remove()\\">Rechazar todas</button></div>";return true})()',
          );
          assert.match(
            await run("act.js", ["consent"]),
            /clicked "rechazar todas"/,
          );
          await expression(
            '(()=>{const host=document.querySelector("#host");host.id="usercentrics-root";host.shadowRoot.innerHTML="<button data-testid=\\"uc-deny-all-button\\" onclick=\\"this.remove()\\">Nein</button>";return true})()',
          );
          assert.match(await run("act.js", ["consent"]), /clicked "nein"/);
          await run("nav.js", [url + "/iframe"]);
          assert.match(await run("act.js", ["consent"]), /in iframe/);
        },
      );
      await t.test(
        "native dialogs are handled while the initiating connection is still alive",
        async () => {
          await run("nav.js", [url + "/meta"]);
          assert.match(
            await run("act.js", ["click", "--target", "#alert"]),
            /alert dismissed/,
          );
          assert.equal(await expression("window.alertDone"), "true");
          await run("act.js", ["click", "--target", "#confirm"]);
          assert.equal(await expression("window.confirmed"), "false");
          await run("act.js", [
            "click",
            "--target",
            "#confirm",
            "--dialog",
            "accept",
          ]);
          assert.equal(await expression("window.confirmed"), "true");
        },
      );
      await t.test(
        "mobile meta viewport, responsive mode and desktop reset stay faithful",
        async () => {
          await run("nav.js", [url + "/no-meta", "--device", "pixel-8"]);
          assert.ok(Number(await expression("innerWidth")) >= 980);
          await run("nav.js", [url + "/meta"]);
          assert.equal(await expression("innerWidth"), "412");
          assert.equal(
            await expression('matchMedia("(max-width:480px)").matches'),
            "true",
          );
          await run("nav.js", [url + "/no-meta", "--viewport", "412x915"]);
          assert.equal(await expression("innerWidth"), "412");
          assert.equal(await expression("navigator.maxTouchPoints"), "0");
          await run("read.js", ["--device", "none", "--expr", "innerWidth"]);
          assert.equal(await expression("innerWidth"), "1280");
        },
      );
      await t.test(
        "tabs keep IDs/numbers and device state is per-target, not global",
        async () => {
          const original = JSON.parse(
            readFileSync(path.join(home, "session.json")),
          ).tabs[0];
          await run("nav.js", [url + "/meta", "--new"]);
          const state = JSON.parse(
            readFileSync(path.join(home, "session.json")),
          );
          const second = state.tabs.find(
            (tab) => tab.targetId !== original.targetId,
          );
          assert.equal(
            state.tabs.find((tab) => tab.targetId === original.targetId).tab,
            original.tab,
          );
          await run("read.js", [
            "--tab",
            String(original.tab),
            "--device",
            "pixel-8",
            "--expr",
            "innerWidth",
          ]);
          assert.equal(
            await expression("innerWidth", ["--tab", String(second.tab)]),
            "1280",
          );
          await run("read.js", [
            "--tab",
            String(second.tab),
            "--device",
            "iphone-15",
            "--expr",
            "innerWidth",
          ]);
          await run("read.js", [
            "--tab",
            String(original.tab),
            "--device",
            "none",
            "--expr",
            "innerWidth",
          ]);
          assert.equal(
            await expression("innerWidth", ["--tab", second.targetId]),
            "393",
          );
          assert.match(await run("session.js", ["status"]), /iphone-15/);
          await run("session.js", ["close", "--tab", String(second.tab)]);
          await run("nav.js", [url + "/meta", "--new"]);
          const latest = JSON.parse(
            readFileSync(path.join(home, "session.json")),
          );
          assert.ok(latest.tabs.some((tab) => tab.tab > second.tab));
          await run("session.js", [
            "close",
            "--tab",
            String(Math.max(...latest.tabs.map((tab) => tab.tab))),
          ]);
          await run("read.js", [
            "--tab",
            String(original.tab),
            "--expr",
            "innerWidth",
          ]);
        },
      );
      await t.test(
        "screenshots report actual pixels and restore temporary emulation",
        async () => {
          await run("nav.js", [url + "/meta", "--device", "none"]);
          const file = path.join(root, "mobile.png");
          await run("shot.js", ["--device", "iphone-15", "--out", file]);
          const png = readFileSync(file);
          assert.equal(png.readUInt32BE(16), 393 * 3);
          assert.equal(statSync(file).mode & 0o777, 0o600);
          assert.equal(await expression("innerWidth"), "1280");
          assert.equal(await expression("navigator.maxTouchPoints"), "0");
          await run("shot.js", [
            "--selector",
            "#form",
            "--out",
            path.join(root, "element.png"),
          ]);
          await run("shot.js", [
            "--full-page",
            "--out",
            path.join(root, "full.png"),
          ]);
          await assert.rejects(
            run("pick.js", ["Pick a button"]),
            /requires a headed/,
          );
        },
      );
      await t.test(
        "trace details includes cookies/POST without --all and preserves redirects",
        async () => {
          const file = path.join(root, "details.ndjson");
          const command = shellCommand("read.js", [
            "--expr",
            '(async()=>{await fetch("/echo",{method:"POST",body:"DUMMY_POST"});await fetch("/redirect",{method:"POST",body:"DUMMY_REDIRECT_POST"});return true})()',
          ]);
          const output = await run("trace.js", [
            "--run",
            command,
            "--details",
            "--out",
            file,
          ]);
          assert.ok(!output.includes("DUMMY"));
          const entries = readFileSync(file, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
          const echo = entries.find((entry) => entry.url?.endsWith("/echo"));
          assert.equal(echo.details.postData, "DUMMY_POST");
          assert.match(echo.details.extraRequestHeaders.Cookie, /DUMMY_COOKIE/);
          assert.equal(echo.details.extraInfoComplete, true);
          const redirect = entries.find((entry) =>
            entry.url?.endsWith("/redirect"),
          );
          assert.equal(redirect.status, 303);
          assert.equal(redirect.details.postData, "DUMMY_REDIRECT_POST");
          const final = entries.find((entry) => entry.url?.endsWith("/final"));
          assert.equal(final.method, "GET");
          assert.equal(final.status, 200);
          assert.match(
            final.details.extraRequestHeaders.Cookie,
            /DUMMY_REDIRECT/,
          );
          assert.equal(statSync(file).mode & 0o777, 0o600);
          assert.ok(!Object.hasOwn(final.details, "postData"));
          const summary = await run("search.js", [
            "DUMMY_POST",
            "--file",
            file,
          ]);
          assert.match(summary, /matches: 1/);
          assert.ok(!summary.includes("DUMMY_POST"));
          const exported = path.join(root, "matches.ndjson");
          await run("search.js", [
            "DUMMY_POST",
            "--file",
            file,
            "--out",
            exported,
          ]);
          assert.match(readFileSync(exported, "utf8"), /DUMMY_POST/);
        },
      );
      await t.test(
        "trace output stays bounded; nonzero exit and timeout propagate",
        async () => {
          const heldTrace = execute(
            process.execPath,
            [path.join(scripts, "trace.js"), "--seconds", "2"],
            { env, timeout: 10000 },
          );
          for (
            let i = 0;
            i < 50 && !existsSync(path.join(home, "trace.lock"));
            i++
          )
            await new Promise((resolve) => setTimeout(resolve, 20));
          await assert.rejects(
            run("read.js", ["--expr", "document.title"]),
            /trace is active/,
          );
          await heldTrace;
          const command = shellCommand("read.js", [
            "--expr",
            '(()=>{for(let i=0;i<1000;i++)console.error("x".repeat(200));return true})()',
          ]);
          const file = path.join(root, "flood.ndjson");
          const output = await run("trace.js", [
            "--run",
            command,
            "--out",
            file,
            "--show-messages",
            "--max-chars",
            "512",
          ]);
          assert.ok(output.length <= 512);
          assert.match(output, /truncated/);
          assert.ok(readFileSync(file, "utf8").length > 200000);
          await assert.rejects(
            run("trace.js", ["--run", "exit 7"]),
            (error) => error.code === 7,
          );
          await assert.rejects(
            run("trace.js", ["--run", "sleep 10", "--timeout", "1"]),
            (error) => error.code === 124,
          );
          const limited = path.join(root, "limited.ndjson");
          assert.match(
            await run("trace.js", [
              "--run",
              command,
              "--out",
              limited,
              "--max-events",
              "5",
            ]),
            /INCOMPLETE/,
          );
          const meta = JSON.parse(readFileSync(limited, "utf8").split("\n")[0]);
          assert.ok(meta.droppedEvents > 0);
          const newTabOutput = await run("trace.js", [
            "--run",
            shellCommand("nav.js", [url + "/meta", "--new"]),
          ]);
          assert.match(newTabOutput, /new tab\(s\).*outside the capture scope/);
          await run("session.js", ["close"]);
        },
      );
    } finally {
      if (started)
        await run("session.js", ["stop"]).catch((error) => {
          console.error("Test browser cleanup failed:", error.message);
          throw error;
        });
      await close(server);
      if (process.env.BROWSER_KEEP_TEST_ARTIFACTS)
        console.log(`Test artifacts: ${root}`);
      else rmSync(root, { recursive: true, force: true });
    }
  },
);
