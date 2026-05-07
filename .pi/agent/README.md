# Custom Pi Agent Configuration

> Located in `~/.pi/agent/`

---

## Skills

| Skill | Description |
|---|---|
| [binary-reversing](skills/binary-reversing/) | Reverse engineering of compiled binaries (ELF, PE, Mach-O). Expertise in radare2, Ghidra decompilation, control flow analysis, vulnerability identification, and CTF challenges. |
| [frontend-design](skills/frontend-design/) | Guides creation of distinctive, production-grade frontend interfaces that avoid generic AI aesthetics. Sourced from [Anthropic's skills](https://github.com/anthropics/skills/tree/main/skills/frontend-design) with small changes. |
| [skill-reviewer](skills/skill-reviewer/) | Review, critique, and create AI agent SKILL.md files. Checks frontmatter, structure, tone, conciseness, success criteria, progressive disclosure, behavioral rules, edge cases, and directory layout against best practices. |
| [web-browser](skills/web-browser/) | Remote control of Chrome/Chromium via the Chrome DevTools Protocol (CDP). Scripts for navigation, screenshots, JS evaluation, element picking, cookie dismissal, device emulation, and network logging. Sourced from [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff/tree/main/skills/web-browser) with changes. |

## Prompt Templates

| Prompt | Description |
|---|---|
| [crackme](prompts/crackme.md) | Structured workflow for solving CrackMe CTF challenges. Loads the `binary-reversing` skill, identifies check functions (`strcmp`/`memcmp`/crypto), decompiles with Ghidra, and derives keys or patches. |

## Extensions

| Extension | Description |
|---|---|
| [info](extensions/info.ts) | `/info` slash command that displays a full session summary: registered tools (active/inactive), skills, prompt templates, loaded context files, system prompt stats, and session metadata. Toggle full mode (`f`) for the complete system prompt. |
| [questionnaire](extensions/questionnaire.ts) | Unified tool for asking the user single or multiple questions. Single questions show a simple option list; multiple questions use a tab-bar interface. Supports free-text "Type something" answers and renders formatted tool calls/results. Sourced from [Pi examples](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/questionnaire.ts). |
| [sanitize-empty-tool-calls](extensions/sanitize-empty-tool-calls.ts) | Hooks into the `context` event to strip degenerate tool call records (empty `id`) produced by some models, preventing 400 errors when switching to Anthropic-based providers. |
| [ssh](extensions/ssh.ts) | Delegates `read`, `write`, `edit`, and `bash` tools to a remote machine via SSH. Supports `--ssh user@host` and `--ssh user@host:/path` flags. Replaces the CWD in the system prompt with the remote path. Emits `ssh:state` events for inter-extension coordination (consumed by `working-mode`). Sourced from [Pi examples](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/ssh.ts) with changes. |
| [working-mode](extensions/working-mode/) | Controls what bash commands the AI can execute with three safety levels: 🔒 **readonly** (read-only commands only, edit/write disabled), ⚡ **normal** (read-only auto-allowed, others ask the user with per-session "always allow" memory), 💀 **berserker** (no restrictions). Cycle with `Ctrl+Tab` or `/wmode`. Pipe-aware sub-command checking. Integrates with `ssh.ts` to hide local-only tools in remote mode. |
