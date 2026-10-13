# Compact tools — phase 1

Presentation-only extension for Pi 1.0.2's public tool-renderer API. Automatically loaded from `~/.pi/agent/extensions/compact-tools/index.ts`; run `/reload` in an existing Pi session.

## Display

- One collapsed row per call: tool, abbreviated path/command, compact English statistics, and status. Durations appear only for `bash`, `powershell`, and `codemode`; reads, edits, writes, and other tools have no clock.
- Below 80 terminal columns, remove the expansion arrow and tool-name alignment padding, use single-space separators, and place the clock immediately after the summary. Wider terminals keep the aligned layout and expansion arrows.
- Preserve Pi's special read labels: `[skill] <name>` with skill colors, `read resource` for `AGENTS.md`/`AGENTS.override.md`/`CLAUDE.md` (including Pi's uppercase variants), and `read docs` for Pi's own README, docs, and examples.
- No result, script, write-content, or diff previews while collapsed.
- Consecutive textual calls share one block: one separator before the block, no internal blank lines or vertical padding. Every call stays visible; burst folding is not implemented.
- Pending/success/error backgrounds use the current Pi theme. Errors include a short reason. Truncation and handled codemode child failures remain indicated.
- Click a row to expand/collapse just that call. `Ctrl+O` (or the configured `app.tools.expand` key) expands/collapses globally. Expanded rows use the original tool renderers and retain all available arguments, output, and diffs; underlying tool-output truncation is unchanged.
- Long collapsed rows are clipped to terminal width, preserving the end of file paths. They never wrap.

Supports built-in `read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, `ls`, `codemode`, `tool_search`, and `mcp__…` tools. Other extension tools, especially interactive tools such as `questionnaire`, retain their original UI and separate groups.

Images remain at their original transcript position and are not merged into text groups. Visible assistant text, thinking labels, user messages, and custom entries separate groups. Consecutive calls join across assistant-message and turn boundaries, including calls issued one at a time. Enabling `showCacheMissNotices` does not itself create a separator: only a cache/usage or thinking-drop notice Pi actually displays does. Notice detection uses public session/model data and mirrors Pi 1.0.2's display thresholds. Reload/resume reconstruct the same grouping.

Execution is never replaced, and neither model-facing results nor prompts are modified. Shell/codemode timings are saved in hidden `compact-tools:timings` session entries outside model context. Recorded durations survive reload/resume/tree navigation. Older timings for other tools are ignored, and calls without recorded timings do not receive invented durations. Non-TUI modes retain their original renderers.

## Notation

- `s:94`: 94 submitted script lines, including comments and wrappers/heredocs; omit single-line scripts.
- `o:34`: 34 logical output lines; omit empty output and Pi's own headers/status text. For truncated shell output, use the original total when available.
- `c:8` / `e:1`: 8 codemode child calls / 1 handled child failure.
- `86L`: 86 written lines; `+12 -4`: edit additions/deletions; `chg:2`: 2 edit operations before a diff is available.
- `trunc`: truncated output; `exit:1`: failed exit code; `123ms`, `1.8s`, `1m5s`: elapsed duration.

Example at mobile width:

```text
✓ [skill] frontend-design
✓ read resource AGENTS.md
✓ read src/asr.py
✓ bash pytest o:34 1.8s
✓ write test.py 86L
✓ edit asr.py +12 -4
✓ codemode s:94 c:8 4.2s
```

## Commands

- `/compact-tools` — show current state and available options.
- `/compact-tools off` — restore Pi's original tool UI, automatically reloading extensions.
- `/compact-tools on` — re-enable the compact UI, automatically reloading extensions.
- `/compact-tools expand` / `/compact-tools collapse` — expand/collapse all tools.

The on/off preference is stored in the current session branch, not global settings. New sessions default to on. No Pi installation files or existing settings are changed.

## Tests

Uses Node's test runner, Pi's installed dependencies, and the real `ToolExecutionComponent`; no model requests or tool executions.

```sh
PI_PACKAGE_DIR=/absolute/path/to/node_modules/@earendil-works/pi-coding-agent \
  node ~/.pi/agent/extensions/compact-tools/tests/run.mjs
```

Tests cover line counts, no folding, sequential and parallel calls, out-of-order completion, streaming boundaries, individual/global expansion, full scripts/writes/diffs, errors, compact metadata/output counts, Unicode/narrow widths and the 80-column breakpoint, native special-read labels/colors, image isolation, selective timing persistence/restoration, actual versus merely enabled notices, disabling, and non-TUI modes.
