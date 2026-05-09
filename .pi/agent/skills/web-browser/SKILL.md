---
name: web-browser
description: "Use when interacting with web pages that require real browser behavior: JavaScript execution, clicking, form filling, navigation, screenshots, cookie-dialog handling, authenticated browser sessions, mobile/device emulation, console/error inspection, or network debugging. Do not use for ordinary web search, static/public URL fetching, simple HTTP requests, downloads, or APIs; use web-search or direct HTTP tools instead."
compatibility:
  - Chrome or Chromium installed
  - Node.js available
allowed-tools:
  - bash
  - read
---

# Web Browser Skill

Use the bundled Chrome DevTools Protocol (CDP) scripts for interactive or JavaScript-dependent web browsing.

Run commands from this skill directory. If your current working directory is elsewhere, use the absolute path to the relevant script.

Prefer `web-search` or direct HTTP tools for ordinary web search, static/public URL fetching, simple downloads, and non-interactive API calls. Use this skill when browser behavior matters: JavaScript rendering, cookies, authenticated browser state, forms, clicks, screenshots, mobile emulation, console logs, or network inspection.

Success criteria: The browsing task uses the simplest reliable tool, and browser scripts are used only when browser behavior is required.

## Start Chrome

Start a managed Chrome or Chromium instance with remote debugging enabled:

```bash
./scripts/start.js                  # Isolated reusable profile (default)
./scripts/start.js --profile        # Copy your profile into isolated cache
./scripts/start.js --reset-profile  # Clear selected cached profile before launch
./scripts/start.js --headless       # Run without GUI (headless mode)
./scripts/start.js --stop           # Stop the managed Chrome instance
```

Use the default debugging port `:9222` unless you need a different endpoint.

Profile behavior:

- Default mode uses: `~/.cache/agent-web/browser/fresh-profile`
- `--profile` mode uses: `~/.cache/agent-web/browser/profile-copy`
- The skill does not attach to a live Chrome profile directly.
- If `:9222` is already used by an unknown instance, startup fails instead of reusing it.

Set a custom Chrome or Chromium binary when it is installed in a non-standard location:

```bash
BROWSER_BIN=/path/to/chrome ./scripts/start.js
```

Override the debug endpoint when the default port is unavailable:

```bash
BROWSER_DEBUG_PORT=9333 ./scripts/start.js
```

Success criteria: Chrome is running with CDP available on the configured port, or the failure has a clear next step such as setting `BROWSER_BIN`, changing `BROWSER_DEBUG_PORT`, or resetting the managed profile.

## Navigate

Navigate the active tab or open a new tab:

```bash
./scripts/nav.js https://example.com
./scripts/nav.js https://example.com --new
```

After navigating, dismiss cookie dialogs when they block interaction, then inspect the page with JavaScript, screenshots, or logs as needed.

Success criteria: The requested URL is loaded in the intended tab and the page is ready for the next interaction or inspection step.

## Device Emulation (Mobile)

List, apply, or reset active device emulation preferences:

```bash
./scripts/emulate.js --list
./scripts/emulate.js iphone-14
./scripts/emulate.js pixel-7 --landscape
./scripts/emulate.js --reset
```

Use device emulation to set viewport, DPR, touch behavior, and user agent for browser skill commands. Run `--reset` when the task should return to desktop behavior.

Commands such as `nav.js`, `eval.js`, `pick.js`, `dismiss-cookies.js`, and `screenshot.js` automatically apply the active preference.

Success criteria: The intended device preset is active for subsequent commands, or emulation is reset when no longer needed.

## Evaluate JavaScript

Execute JavaScript in the active tab:

```bash
./scripts/eval.js 'document.title'
./scripts/eval.js 'document.querySelectorAll("a").length'
./scripts/eval.js 'JSON.stringify(Array.from(document.querySelectorAll("a")).map(a => ({ text: a.textContent.trim(), href: a.href })).filter(link => !link.href.startsWith("https://")))'
```

Use single quotes around the JavaScript argument to reduce shell escaping issues. Keep snippets focused and return serializable values when you need structured output.

Success criteria: The script runs in the active tab and returns the expected value or a useful error for the next debugging step.

## Screenshot

Capture the current viewport, full page, or a temporary device-specific view:

```bash
./scripts/screenshot.js
./scripts/screenshot.js --full-page
./scripts/screenshot.js --device iphone-14
./scripts/screenshot.js --device pixel-7 --full-page
```

Use `--full-page` when layout below the fold matters. Use `--device <preset>` when you need a one-off mobile screenshot without changing the active emulation preference.

Success criteria: The command returns a readable screenshot file path that captures the relevant page state.

## Pick Elements

Use the interactive element picker when selectors are unclear or visual selection is faster:

```bash
./scripts/pick.js "Click the submit button"
```

Click to select an element, Cmd/Ctrl+Click to select multiple elements, and press Enter to finish.

Success criteria: The target element or elements are selected accurately enough to support the next action or selector-based inspection.

## Dismiss Cookie Dialogs

Dismiss cookie consent dialogs after navigating to a page:

```bash
./scripts/dismiss-cookies.js          # Accept cookies
./scripts/dismiss-cookies.js --reject # Reject cookies where possible
```

Run it immediately after navigation when a consent dialog blocks the page:

```bash
./scripts/nav.js https://example.com && ./scripts/dismiss-cookies.js
```

Prefer `--reject` when the task does not require accepting optional cookies.

Success criteria: The cookie dialog no longer blocks page interaction, or the command reports that no supported dialog was found.

## Quick Mobile Debug Flow

Use this sequence for a first pass at mobile layout or interaction issues:

```bash
./scripts/start.js
./scripts/nav.js https://example.com
./scripts/emulate.js iphone-14
./scripts/nav.js https://example.com      # Reload with mobile user agent
./scripts/dismiss-cookies.js
./scripts/screenshot.js --full-page
```

Reload after setting mobile emulation so the page receives the mobile user agent during initial load.

Success criteria: The page is loaded under the selected mobile emulation, blocking cookie dialogs are handled, and a full-page screenshot is available for review.

## Background Logging (Console + Errors + Network)

Use background logs to inspect console output, page errors, and network activity. Logging starts automatically with `start.js` and writes JSONL files to:

```text
~/.cache/agent-web/logs/YYYY-MM-DD/<targetId>.jsonl
```

Start logging manually when needed:

```bash
./scripts/watch.js
```

Tail the latest log:

```bash
./scripts/logs-tail.js           # Dump current log and exit
./scripts/logs-tail.js --follow  # Keep following
```

Summarize network responses:

```bash
./scripts/net-summary.js
```

Success criteria: Console messages, errors, and network responses relevant to the active page are visible through logs or summaries.

## Troubleshooting

Use these fallbacks when a browser command fails:

- If Chrome or Chromium is not found, set `BROWSER_BIN=/path/to/chrome` before `./scripts/start.js`.
- If the debug port is busy, run `./scripts/start.js --stop` for the managed instance or set `BROWSER_DEBUG_PORT` to an unused port.
- If browser state appears stale or corrupted, restart with `./scripts/start.js --reset-profile`.
- If navigation appears stuck, capture a screenshot, tail logs, and check network summaries before retrying.
- If JavaScript evaluation fails because of quoting, simplify the snippet or wrap it in single quotes with escaped inner quotes.
- If a visual interaction is ambiguous, use `pick.js` to identify the element before evaluating selectors or clicking.

Success criteria: Failures lead to a specific recovery action instead of repeated retries with the same command.
