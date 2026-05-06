/**
 * Working Mode Extension
 *
 * Controls what bash commands the AI can execute, with three safety levels:
 *
 *   🔒 readonly  — only read-only commands (git status, grep, rg, find, pytest…)
 *                  edit + write tools are disabled
 *   ⚡ normal    — read-only commands auto-allowed; anything else asks the user
 *                  (with per-session "always allow" memory)
 *   💀 berserker — no restrictions; everything is allowed without confirmation
 *
 * Features:
 *   • Tab             cycle modes  (readonly → normal → berserker → …)
 *   • /wmode          show selector or set mode directly  (/wmode readonly)
 *   • --wmode flag    set default mode at startup  (pi --wmode readonly)
 *   • Session memory  remember accepted commands for the whole session,
 *                     with exact, wildcard, or custom (editable) patterns
 *   • cd auto-allow   cd to the current dir / any subdirectory never needs
 *                     confirmation regardless of mode
 *   • Pipe-aware      each sub-command in |, ||, &&, ; chains is checked
 *                     individually; any non-allowed one triggers the gate
 *   • Status bar      always shows the active mode in the footer
 *
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import {
	isCdToSubdirOrSame,
	isReadonlyCommand,
	isVarAssignment,
	matchesSessionPattern,
	splitIntoSubcommands,
	suggestPattern,
} from "./utils.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export type WorkingMode = "readonly" | "normal" | "berserker";

// ─── Constants ───────────────────────────────────────────────────────────────

// Shared inter-extension contract with ssh.ts:
// - ssh.ts emits "ssh:state" with { remote, remoteCwd } when SSH is active
// - ssh.ts emits null when SSH is inactive
// working-mode listens to this so it can hide local-only tools (grep/find/ls)
// while the session is operating against a remote machine.
const SSH_STATE_EVENT = "ssh:state";
const SSH_UNSUPPORTED_TOOLS = new Set(["grep", "find", "ls"]);

const READONLY_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire"];
const FULL_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "questionnaire"];

const MODE_CYCLE: WorkingMode[] = ["readonly", "normal", "berserker"];

type ThemeColor = "warning" | "accent" | "error";

const MODE_STATUS: Record<WorkingMode, { label: string; color: ThemeColor }> = {
	readonly: { label: "🔒 readonly", color: "warning" },
	normal: { label: "⚡ normal", color: "accent" },
	berserker: { label: "💀 berserker", color: "error" },
};

// ─── Extension ───────────────────────────────────────────────────────────────

export default function workingModeExtension(pi: ExtensionAPI): void {
	let currentMode: WorkingMode = "normal";
	let sshActive = false;

	/**
	 * Commands (and/or patterns) accepted by the user for the whole session.
	 * Populated dynamically when the user chooses "Allow for session".
	 */
	const sessionAcceptedPatterns: string[] = [];

	pi.events.on(SSH_STATE_EVENT, (state: { remote: string; remoteCwd: string } | null) => {
		sshActive = state !== null;
		applyModeTools(currentMode);
	});

	// ── CLI flag ────────────────────────────────────────────────────────────

	pi.registerFlag("wmode", {
		description: 'Default working mode: "readonly", "normal" (default), or "berserker"',
		type: "string",
		default: "normal",
	});

	// ── Helpers ─────────────────────────────────────────────────────────────

	function applyModeTools(mode: WorkingMode): void {
		const baseTools = mode === "readonly" ? READONLY_TOOLS : FULL_TOOLS;
		const effectiveTools = sshActive ? baseTools.filter((tool) => !SSH_UNSUPPORTED_TOOLS.has(tool)) : baseTools;
		pi.setActiveTools(effectiveTools);
	}

	function updateStatus(ctx: ExtensionContext): void {
		const { label, color } = MODE_STATUS[currentMode];
		ctx.ui.setStatus("working-mode", ctx.ui.theme.fg(color, label));
	}

	function setMode(mode: WorkingMode, ctx: ExtensionContext, silent = false): void {
		currentMode = mode;
		applyModeTools(mode);
		updateStatus(ctx);
		if (!silent) {
			ctx.ui.notify(`Working mode → ${mode}`, "info");
		}
		// Persist so the mode survives /resume
		pi.appendEntry("working-mode-state", { mode });
	}

	function cycleMode(ctx: ExtensionContext): void {
		const next = MODE_CYCLE[(MODE_CYCLE.indexOf(currentMode) + 1) % MODE_CYCLE.length];
		setMode(next, ctx);
	}

	/**
	 * Returns true if a single sub-command is auto-allowed without prompting.
	 */
	function isAutoAllowed(subCmd: string, cwd: string): boolean {
		// Berserker: everything is unconditionally allowed
		if (currentMode === "berserker") return true;

		const trimmed = subCmd.trim();

		// Bash comments are silently ignored
		if (trimmed.startsWith("#")) return true;

		// Pure variable assignments (no command substitution) are safe
		if (isVarAssignment(trimmed)) return true;

		// cd to the current directory or any subdirectory is always OK
		if (trimmed === "cd" || trimmed.startsWith("cd ")) {
			if (isCdToSubdirOrSame(subCmd, cwd)) return true;
		}

		// Standard read-only commands
		if (isReadonlyCommand(subCmd)) return true;

		// Commands previously accepted by the user for this session
		if (sessionAcceptedPatterns.some((p) => matchesSessionPattern(subCmd, p))) return true;

		return false;
	}

	// ── Shortcut ─────────────────────────────────────────────────────────────

	pi.registerShortcut(Key.ctrl("tab"), {
		description: "Cycle working mode (readonly → normal → berserker → …)",
		handler: async (ctx) => cycleMode(ctx),
	});

	// ── Command ──────────────────────────────────────────────────────────────

	pi.registerCommand("wmode", {
		description: "Show or set working mode: /wmode [readonly|normal|berserker]",
		getArgumentCompletions: (prefix: string) => {
			const modes = ["readonly", "normal", "berserker"];
			const matching = modes.filter((m) => m.startsWith(prefix));
			return matching.length > 0 ? matching.map((m) => ({ value: m, label: m })) : null;
		},
		handler: async (args, ctx) => {
			const arg = args?.trim().toLowerCase();

			if (!arg) {
				// Show interactive selector
				const choice = await ctx.ui.select(
					`Current working mode: ${currentMode}\n\nSelect mode:`,
					[
						"🔒 readonly  — only read-only commands allowed",
						"⚡ normal    — read-only auto-allowed; confirm others",
						"💀 berserker — no restrictions",
					],
				);
				if (!choice) return;
				if (choice.startsWith("🔒")) setMode("readonly", ctx);
				else if (choice.startsWith("⚡")) setMode("normal", ctx);
				else if (choice.startsWith("💀")) setMode("berserker", ctx);
				return;
			}

			// Direct mode argument
			if (arg === "readonly" || arg === "ro" || arg === "r") {
				setMode("readonly", ctx);
			} else if (arg === "normal" || arg === "n") {
				setMode("normal", ctx);
			} else if (arg === "berserker" || arg === "b" || arg === "berserk") {
				setMode("berserker", ctx);
			} else {
				ctx.ui.notify(`Unknown mode "${arg}". Options: readonly | normal | berserker`, "error");
			}
		},
	});

	// ── Tool call gate ───────────────────────────────────────────────────────

	pi.on("tool_call", async (event, ctx) => {
		// Safety gate: Pi resolves tools against a snapshot taken at turn start,
		// so setActiveTools() mid-stream won't be seen by the agent loop.
		// We check the live active set here to close that gap.
		if (!pi.getActiveTools().includes(event.toolName)) {
			return { block: true, reason: `Tool "${event.toolName}" is not active in ${currentMode} mode` };
		}

		if (event.toolName !== "bash") return undefined;

		const rawCommand = event.input.command as string;
		const cwd = ctx.cwd;

		// Berserker: unconditional pass-through
		if (currentMode === "berserker") return undefined;

		// Decompose into individual sub-commands
		const subCommands = splitIntoSubcommands(rawCommand);
		const nonAllowed = subCommands.filter((cmd) => !isAutoAllowed(cmd, cwd));

		// All sub-commands are auto-allowed
		if (nonAllowed.length === 0) return undefined;

		// ── Read-only mode: hard block ────────────────────────────────────

		if (currentMode === "readonly") {
			return {
				block: true,
				reason: [
					"Working mode [read-only]: command blocked.",
					"",
					"Blocked sub-command(s):",
					...nonAllowed.map((c) => `  • ${c}`),
					"",
					"Switch to normal or berserker mode with /wmode or Ctrl+Tab.",
				].join("\n"),
			};
		}

		// ── Normal mode, no UI: block (behaves like read-only) ────────────

		if (!ctx.hasUI) {
			return {
				block: true,
				reason: [
					"Working mode [normal, non-interactive]: command blocked.",
					"Blocked sub-command(s):",
					...nonAllowed.map((c) => `  • ${c}`),
				].join("\n"),
			};
		}

		// ── Normal mode, with UI: ask the user ────────────────────────────

		const displayCmd = rawCommand.length > 500 ? `${rawCommand.slice(0, 497)}…` : rawCommand;
		const nonAllowedList = nonAllowed.map((c) => `  • ${c}`).join("\n");

		const choice = await ctx.ui.select(
			`⚠️  Working Mode [normal] — non-read-only sub-command(s) detected:\n\n${nonAllowedList}\n\nFull command:\n  ${displayCmd}`,
			["✅  Allow once", "📌  Allow for session…", "🚫  Block"],
		);

		// Escape or Block
		if (!choice || choice.startsWith("🚫")) {
			return { block: true, reason: "Blocked by user (working mode)" };
		}

		// Allow once
		if (choice.startsWith("✅")) return undefined;

		// ── Allow for session: choose pattern type ────────────────────────

		const exactPatterns = nonAllowed.map((c) => c.trim());
		const wildcardPatterns = nonAllowed.map((c) => suggestPattern(c));

		const truncated = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
		const exactDisplay = exactPatterns.map((p) => `"${truncated(p)}"`).join(", ");
		const wildcardDisplay = wildcardPatterns.map((p) => `"${truncated(p)}"`).join(", ");

		const patternChoice = await ctx.ui.select(
			"📌  Allow for session — how should this be remembered?",
			[
				`Exact:    ${exactDisplay}`,
				`Wildcard: ${wildcardDisplay}`,
				"Custom…   (open pattern editor)",
			],
		);

		if (!patternChoice) {
			// User escaped → allow once, don't remember
			return undefined;
		}

		if (patternChoice.startsWith("Exact:")) {
			for (const p of exactPatterns) sessionAcceptedPatterns.push(p);
			ctx.ui.notify(`Session allow (exact): ${exactDisplay}`, "info");
		} else if (patternChoice.startsWith("Wildcard:")) {
			for (const p of wildcardPatterns) sessionAcceptedPatterns.push(p);
			ctx.ui.notify(`Session allow (wildcard): ${wildcardDisplay}`, "info");
		} else {
			// Open editor so the user can fine-tune the patterns
			const initialText = wildcardPatterns.join("\n");
			const edited = await ctx.ui.editor(
				[
					"Edit session patterns — one per line.",
					"Use * as a wildcard,  e.g.:  npm install *",
					"Empty lines are ignored.",
				].join("\n"),
				initialText,
			);
			const patterns = (edited ?? "")
				.split("\n")
				.map((p) => p.trim())
				.filter((p) => p.length > 0);
			if (patterns.length > 0) {
				for (const p of patterns) sessionAcceptedPatterns.push(p);
				ctx.ui.notify(
					`Session allow (custom): ${patterns.map((p) => `"${truncated(p)}"`).join(", ")}`,
					"info",
				);
			}
			// If the user submitted nothing → allow once, don't remember
		}

		return undefined; // allow this invocation
	});

	// ── System prompt injection ──────────────────────────────────────────────

	pi.on("before_agent_start", async (event) => {
		if (currentMode === "readonly") {
			return {
				systemPrompt:
					event.systemPrompt +
					"\n\n[WORKING MODE: read-only]\n" +
					"You may only use read-only bash commands (grep, rg, find, cat, ls, git status, git log, " +
					"git diff, pytest, curl, etc.).  The edit and write tools are disabled.\n" +
					"Do NOT attempt to create, modify, or delete files.",
			};
		}
		if (currentMode === "berserker") {
			return {
				systemPrompt:
					event.systemPrompt +
					"\n\n[WORKING MODE: berserker]\n" +
					"All commands and tools are enabled without restriction.",
			};
		}
		// normal mode — no extra injection needed
		return undefined;
	});

	// ── Session start / restore ──────────────────────────────────────────────

	pi.on("session_start", async (event, ctx) => {
		// Determine initial mode from CLI flag
		let initialMode: WorkingMode = "normal";
		const wmodeFlag = pi.getFlag("wmode");
		if (typeof wmodeFlag === "string" && wmodeFlag) {
			const f = wmodeFlag.toLowerCase().trim();
			if (f === "readonly" || f === "ro" || f === "r") initialMode = "readonly";
			else if (f === "berserker" || f === "b" || f === "berserk") initialMode = "berserker";
		}

		// On resume / fork, restore the last persisted mode
		if (event.reason === "resume" || event.reason === "fork") {
			const entries = ctx.sessionManager.getEntries();
			const stateEntry = entries
				.filter(
					(e: { type: string; customType?: string }) =>
						e.type === "custom" && e.customType === "working-mode-state",
				)
				.pop() as { data?: { mode: WorkingMode } } | undefined;

			if (stateEntry?.data?.mode) {
				initialMode = stateEntry.data.mode;
			}
		}

		// Note: session-accepted patterns are intentionally NOT restored —
		// they are per-session-runtime, not persisted.

		currentMode = initialMode;
		applyModeTools(initialMode);
		updateStatus(ctx);
	});
}
