# Desktop workflows and tests

## Use a headed browser and the human picker

```bash
node scripts/session.js stop
node scripts/session.js start --headed
node scripts/nav.js https://example.com
node scripts/pick.js 'Select the intended control' --tab 1
```

Use the picker only with a human at the display. A click selects one element, Ctrl/Cmd+click adds elements, Enter finishes a multi-selection, and Escape cancels. The picker returns unique selectors, not raw HTML; it cleans its overlay on completion, cancellation, or timeout. Headless mode fails immediately instead of waiting for an impossible interaction.

Use `read.js --forms` or `--links` for ordinary autonomous browsing. Use screenshots when the task is visual. Do not assume the picker can replace programmatic inspection in a server environment.

**Success criteria:** The intended element is selected by the human, or the autonomous read/screenshot alternative identifies it without an unattended GUI wait.

## Copy an authorized desktop profile explicitly

Prefer logging in once inside the isolated managed profile. Copy a real desktop profile only when the user authorizes access to its authenticated sessions and the task actually requires that state:

```bash
node scripts/session.js stop
node scripts/session.js start --headed --profile
# Optional source override (Chrome user-data directory, not just its Default subdirectory):
node scripts/session.js start --headed --profile --profile-source /path/to/chrome-user-data
```

Close the source browser before copying for a consistent snapshot. `rsync` is required for this optional mode. The copy excludes Chrome singleton locks and debugging-port files. It is placed in `~/.cache/agent-web/browser/profile-copy`, never attached directly to the live source. A fresh launch with `--profile` refreshes the copy; starting an already running matching instance reuses it.

The default isolated profile is `~/.cache/agent-web/browser/fresh-profile`. Use `--reset-profile` only when stopped and intentionally clearing the selected cached profile. The command refuses a profile with a live Chrome singleton before deleting or overwriting it. A copy can still contain valuable credentials, history, and extensions: isolation and loopback are not substitutes for authorization or local-machine security.

Chrome is launched detached. It can survive the CLI/Pi process; a surrounding service manager may still terminate its process group or cgroup. Use `session.js stop` rather than relying on Pi shutdown. Browser restarts may restore tabs; inspect `session.js tabs` after starting.

**Success criteria:** The chosen source and destination are understood, no running profile is overwritten, and authenticated state is accessed only as authorized.

## Run regression tests

No npm install is necessary:

```bash
node --test scripts/test/unit.test.js
node --test scripts/test/integration.test.js
# Or:
npm test --prefix scripts
npm run test:browser --prefix scripts
```

The integration suite requires Chrome or Chromium with a working sandbox. It creates its own temporary `BROWSER_HOME`, HTTP fixture, and debug port; uses fake credentials only; and stops only its own managed browser. Override the test binary with `BROWSER_TEST_BIN=/path/to/chrome`. Set `BROWSER_KEEP_TEST_ARTIFACTS=1` to preserve temporary evidence for diagnosis; the default cleans it up. A missing browser or sandbox is a failure to fix, not a silently skipped test or automatic no-sandbox retry.

The tests cover output budgets, endpoint ownership and custom ports, stable tab addressing, mobile meta viewport versus responsive sizing, per-tab reset, temporary screenshots, unique selectors and shadow roots, input, keyboard and upload behavior, conservative consent, native dialogs, sensitive capture and redirects, retrospective search, command exit codes, and timeouts.

Also exercise these realistic prompts when changing the workflow:

1. “Open this local test page, identify the green radio option, fill the controlled input, upload a file through its hidden input, and verify the submitted value.”
2. “Compare the page with and without a meta viewport under mobile emulation, then return only this tab to desktop without changing a second mobile tab.”
3. “Capture this authorized POST/redirect flow, identify the request and whether its cookies/body were captured, without printing secrets or replaying the request.”

The automated suite does not validate live sites, every CMP or language, physical devices, Firefox/WebKit, or the human picker UI. Inspect those manually only when a task or change requires them.

**Success criteria:** Unit and Chromium integration tests pass, the observed change is covered by a regression test, and untested capabilities are not advertised as verified.
