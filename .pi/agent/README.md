# Custom Pi Agent Configuration

> Located in `~/.pi/agent/`

---

## Skills

| Skill                                        | Description                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [binary-reversing](skills/binary-reversing/) | Reverse engineering of compiled binaries (ELF, PE, Mach-O). Expertise in radare2, Ghidra decompilation, control flow analysis, vulnerability identification, and CTF challenges.                                                                                                                                                               |
| [frontend-design](skills/frontend-design/)   | Guides creation of distinctive, production-grade frontend interfaces that avoid generic AI aesthetics. Sourced from [Anthropic's skills](https://github.com/anthropics/skills/tree/main/skills/frontend-design) with small changes.                                                                                                            |
| [skill-reviewer](skills/skill-reviewer/)     | Review, critique, and create AI agent SKILL.md files. Checks frontmatter, structure, tone, conciseness, success criteria, progressive disclosure, behavioral rules, edge cases, and directory layout against best practices.                                                                                                                   |
| [web-browser](skills/web-browser/)           | Remote control of Chrome/Chromium via the Chrome DevTools Protocol (CDP). Use for JavaScript-dependent pages, clicks, forms, screenshots, authenticated browser sessions, console inspection, and network debugging. Sourced from [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff/tree/main/skills/web-browser) with changes. |
| [web-search](skills/web-search/)             | Public web search (Exa, TinyFish and Tavily merged) and live URL-to-Markdown extraction with provider fallback, via local scripts and provider HTTP APIs. Use for ordinary search, current facts, documentation lookup and source comparison.                                                                                                     |

## Prompt Templates

| Prompt                        | Description                                                                                                                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [crackme](prompts/crackme.md) | Structured workflow for solving CrackMe CTF challenges. Loads the `binary-reversing` skill, identifies check functions (`strcmp`/`memcmp`/crypto), decompiles with Ghidra, and derives keys or patches. |

## Extensions

| Extension                                                            | Description                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [codex-usage](extensions/codex-usage.ts) | Shows the Codex subscription quota (5h and weekly windows) in Pi's footer for `openai`/`openai-codex` OAuth models, read with the legacy `openai-codex` login after every run and every 5 minutes while idle; transient failures keep the last value. When a run stops on a usage limit, waits until the quota resets and continues automatically (like Claude Code). The reset time comes from the Codex quota, 429 headers or the error text, with a backoff fallback. Typing a prompt cancels; `/autoresume [now\|cancel\|on\|off]`. Pi must stay open. Footer based on [llblab/pi-codex-usage](https://github.com/llblab/pi-codex-usage). |
| [compact-tools](extensions/compact-tools/)                           | Compact, grouped tool rows without previews, with short English metadata and a mobile-width layout. Preserves themed status backgrounds, special skill/resource read labels, shell/codemode durations, and individual/global expansion. `/compact-tools on|off` switches presentation and reloads extensions. Phase 1 keeps every call visible; no burst folding yet. |
| [double-ctrl-d-exit](extensions/double-ctrl-d-exit.ts)               | Requires a second `Ctrl+D` within one second to quit when the prompt is empty. The first press shows a footer hint; `Ctrl+D` with text still deletes forward. Scoped to the prompt editor, so `Ctrl+D` keeps working in selectors and overlays.                                                                                                                                                                                             |
| [info](extensions/info.ts)                                           | `/info` slash command that displays a full session summary: registered tools (active/inactive), skills, prompt templates, loaded context files, system prompt stats, and session metadata. Toggle full mode (`f`) for the complete system prompt.                                                                                                                                                                                           |
| [notify](extensions/notify.ts)                                       | Sends desktop notifications when Pi finishes a run or needs user input. Avoids notifying while the Pi window is focused, includes a click-to-focus action on Sway, and falls back to the terminal bell when desktop notifications are unavailable.                                                                                                                                                                                        |
| [questionnaire](extensions/questionnaire.ts)                         | Unified tool for asking the user single or multiple questions. Single questions show a simple option list; multiple questions use a tab-bar interface. Supports free-text "Type something" answers and renders formatted tool calls/results. Sourced from [Pi examples](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/questionnaire.ts).                                                          |
| [environment](extensions/environment/) | Unified execution environment: local Bubblewrap (default), unrestricted local execution (`--direct`), or SSH (`--ssh user@host[:/path]`). Routes the four basic tools, `!`, and calls from `codemode`; `/env` manages targets, resource grants and SSH skills. `request_access` asks for session-persisted path, SSH-agent, Docker or external MCP access. Keeps local AGENTS.md instructions and never replaces the full system prompt. Replaces `ssh` and `working-mode`; see its README for commands and limits. |

## Human Setup Notes

### web-search

The `web-search` skill reads provider credentials from its own `.env` file
instead of shell environment variables.

Initial setup:

```bash
cp ~/.pi/agent/skills/web-search/.env.example ~/.pi/agent/skills/web-search/.env
$EDITOR ~/.pi/agent/skills/web-search/.env
chmod 600 ~/.pi/agent/skills/web-search/.env
chmod +x ~/.pi/agent/skills/web-search/scripts/search.js ~/.pi/agent/skills/web-search/scripts/fetch.js
```

`.env` values (configure all three for full coverage; a missing key only
disables that provider):

```bash
EXA_API_KEY=...
TINYFISH_API_KEY=sk-tinyfish-...
TAVILY_API_KEY=tvly-...
```

Search merges the three providers; fetch tries Exa, then TinyFish (needed for
Reddit and X), then Tavily.

Smoke test:

```bash
~/.pi/agent/skills/web-search/scripts/search.js "test query" -n 1
~/.pi/agent/skills/web-search/scripts/fetch.js https://example.com
```
