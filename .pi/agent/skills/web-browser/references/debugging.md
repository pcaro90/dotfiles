# Debugging and sensitive captures

## Recover from a failure

- **Browser not found:** set `BROWSER_BIN=/absolute/path/to/chrome`. System installs are preferred over Playwright caches, because a cached test browser may be old. `PLAYWRIGHT_BROWSERS_PATH` is supported.
- **Startup failed:** inspect the returned private Chrome log. A missing library, locked profile or unavailable display is not fixed by disabling the sandbox. Use headless mode without a display; use `--no-sandbox` only for a diagnosed sandbox restriction.
- **Port occupied / identity mismatch:** stop the managed instance if its identity still verifies, or choose a free port for a new instance. Do not kill an unverified process. A custom port is persisted, so unset a conflicting `BROWSER_DEBUG_PORT` on later commands.
- **Foreground lock occupied:** wait for the other action. Stale locks from dead processes are recovered; an incomplete lock file is refused rather than risking concurrent writes.
- **No open tabs:** run `nav.js URL --new`. Tab numbers can have gaps and reset after a new browser process starts.
- **Navigation timeout:** read/screenshot the page that remains. Try `--wait none --until CSS` for the actual content, `--wait domcontentloaded`, or a larger `--timeout`. Hash navigation does not require a new load event. Actions using `--wait load` expect a real document navigation, not just a SPA state change.
- **Missing/ambiguous element:** refresh `read.js --forms`/`--links`. Selectors are unique for the observed DOM, not permanent references. Use `>>>` for open shadow roots; closed roots and general iframe interaction require explicit CDP work or a different browser tool.
- **Covered element:** inspect `shot.js`, dismiss the relevant overlay, or scroll. Do not bypass hit testing with `.click()` just to report success.
- **Typing did not land:** verify editability/focus and use `--clear --slow` for a strict text input. Avoid typing again without checking whether the first attempt already changed its value.
- **Consent not found:** inspect the page or frame. The heuristic intentionally avoids generic OK/Continue buttons. It reports inaccessible frames; absence of a match is not proof that no banner exists.
- **Native dialog:** commands subscribe before acting and dismiss/cancel by default. Use `--dialog accept` on the initiating action only when authorized. A dialog left open after the initiating connection has already vanished can block a newly attached session in some Chromium versions. If normal commands cannot recover, close that specific tab with `session.js close --tab N` and repeat the flow with dialog handling active; do not destroy unrelated tabs.
- **Emulation confusion:** inspect `session.js status` for each tab's intended preference; run `read.js --tab N --expr '({width:innerWidth,dpr:devicePixelRatio,touch:navigator.maxTouchPoints})'` for the applied state. `--device none` changes only that tab. It restores a deterministic 1280x800 desktop viewport, not an arbitrary prior GUI window size.
- **Authentication wall / automation blocked:** authenticate once in the managed profile, within the user's authorization. Report bot protection or missing permissions instead of attempting to bypass them.

**Success criteria:** The next action addresses the identified failure and is safer than repeating the same command blindly.

## Capture a sensitive request without printing it

Open and inspect the target tab first. Prepare fields outside the trace if their setup is not relevant. Start the trace before the submission:

```bash
node scripts/trace.js --tab 1 --details --pattern login --out /tmp/login.ndjson \
  --run 'node scripts/act.js click --tab 1 --target "button[type=submit]" --wait load'
node scripts/search.js login --file /tmp/login.ndjson
node scripts/search.js login --file /tmp/login.ndjson --out /tmp/login-matches.ndjson
```

Replace `login` with the actual URL substring; filtering on a guessed endpoint can discard the request you need. Omit `--pattern` for a first exploratory capture. `search.js` can also find text inside saved bodies/headers without echoing matching values; its default output only identifies the source file, line, method, status and redacted URL. Use `--out` to keep full matching records on disk.

Read only the minimum authorized fields when reconstructing an HTTP request. Prefer a local script that reads the saved record and writes a private shell script/config rather than printing headers, cookies, or credentials into the conversation. Do not automatically replay a request: it can submit a payment, create an account, or repeat another non-idempotent action. Return placeholders in user-facing examples unless actual values were specifically requested and safe to disclose.

The record format has one `kind: "request"` entry per redirect hop:

```json
{
  "kind": "request",
  "sessionId": "...",
  "requestId": "...",
  "hop": 1,
  "method": "POST",
  "url": "https://example.test/login",
  "status": 303,
  "finished": true,
  "details": {
    "requestHeaders": {},
    "postData": "...",
    "extraRequestHeaders": {},
    "associatedCookies": [],
    "responseHeaders": {},
    "extraResponseHeaders": {},
    "extraInfoComplete": true
  }
}
```

Prefer `extraRequestHeaders` for actual wire headers; the basic request event often omits Cookie. Preserve the relevant headers, method, URL and body together. Review `extraInfoComplete`, `postDataError`, `finished`, and any `unmatched-extra-info` records. Do not claim exact reconstruction when evidence is missing. Redirect hops share request IDs, so use `(sessionId, requestId, hop)`, not request ID alone.

**Success criteria:** The authorized request can be identified from complete evidence, or its missing data is reported; secrets remain in private files rather than tool output.

## Understand trace scope and budgets

- Capture subscribes before enabling the selected sessions and before running the shell command. It records **existing page targets only**. Open popups/tabs before the capture; new page targets are reported as omitted. Requests inside worker and out-of-process iframe targets are outside this scope. A clean trace is not proof of zero network activity everywhere.
- `Runtime.enable`/`Log.enable` may replay buffered console/log entries. Treat the file as diagnostic evidence, not an exact chronological transcript of only the shell command.
- The default noise filter keeps document/XHR/fetch requests, failed/static HTTP errors, warnings and exceptions. `--all` also retains successful static resources and ordinary console logs. `--pattern` applies to URLs/messages, not to secret body contents.
- `--seconds` is 1–300 seconds (default 5). `--run` instead has a default 60-second deadline, configurable with `--timeout` up to 300 seconds. Allow a settling period after the command with `--settle-ms` (default 500, maximum 5000).
- Memory is bounded by 20000 protocol events and a 16 MiB accounting budget. `--max-events` can change the event limit; budget exhaustion is marked `INCOMPLETE`, with a dropped-event count. This is not an unlimited forensic recorder.
- Chrome's initial POST-data buffer is 1 MB. Missing bodies are requested via `Network.getRequestPostData`; unavailable data is flagged. Uploaded file contents and response bodies are not collected.
- Child stdout/stderr is a rolling 16 KiB private tail, including a discarded-byte count. It is not automatically printed. A timeout terminates the child process group; do not use `--run` to launch deliberately detached daemons.
- `--max-chars` bounds the complete CLI output, not stored records. The log path is printed first. New captures and exported results use 0600, including when overwriting an existing permissive file; symlink outputs are refused.
- URLs in trace/search summaries have userinfo, query and fragments redacted. Path segments and console text can still contain secrets. All trace files, screenshots and browser logs may be sensitive, even without `--details`.
- Artifacts are retained until explicitly removed. Delete finished captures from the artifacts directory when no longer needed. Do not delete the profile/cache root to clean logs unless you also intend to discard authentication state.

**Success criteria:** Interpret results within the documented scope and limits, preserve evidence needed for the task, and remove sensitive artifacts when they are no longer needed.
