/**
 * Working Mode Extension
 *
 * Controls what bash commands the AI can execute, with three safety levels:
 *
 *   🔒 readonly  — only read-only commands (git status, grep, rg, find…)
 *                  edit + write tools are disabled
 *   ⚡ normal    — read-only and trusted workflow commands are auto-allowed;
 *                  anything else asks the user
 *                  (with per-session "always allow" memory)
 *   💀 berserker — no restrictions; everything is allowed without confirmation
 *
 * Features:
 *   • Ctrl+Tab        cycle modes  (readonly → normal → berserker → …)
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

import { isToolCallEventType, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import {
	hasUnsafeShellSyntax,
	isCdToSubdirOrSame,
	isNormalAutoAllowedCommand,
	isPathInsideSkill,
	isReadonlyCommand,
	isSafeSedCommand,
	isSkillScriptCommand,
	isVarAssignment,
	matchesSessionPattern,
	resolveCdTarget,
	sandboxSedCommand,
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
const FULL_TOOLS = ["read", "bash", "edit", "write", "questionnaire"];

const MODE_CYCLE: WorkingMode[] = ["readonly", "normal", "berserker"];
const MODE_ALIASES = new Map<string, WorkingMode>([
	["readonly", "readonly"], ["ro", "readonly"], ["r", "readonly"],
	["normal", "normal"], ["n", "normal"],
	["berserker", "berserker"], ["berserk", "berserker"], ["b", "berserker"],
]);

function parseMode(value: unknown): WorkingMode | undefined {
	return typeof value === "string" ? MODE_ALIASES.get(value.trim().toLowerCase()) : undefined;
}

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
	let skillRoots: string[] = [];

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

	function setMode(mode: WorkingMode, ctx: ExtensionContext): void {
		currentMode = mode;
		applyModeTools(mode);
		updateStatus(ctx);
		ctx.ui.notify(`Working mode → ${mode}`, "info");
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

		// Explicit session rules override the automatic classifiers.
		if (sessionAcceptedPatterns.some((pattern) => matchesSessionPattern(subCmd, pattern))) return true;

		// Trust skill scripts, but not shell substitutions or redirections around them.
		if (hasUnsafeShellSyntax(subCmd)) return false;
		if (isSkillScriptCommand(subCmd, cwd, skillRoots)) return true;

		// cd to the current directory, a subdirectory, or a loaded skill is OK.
		if (trimmed === "cd" || trimmed.startsWith("cd ")) {
			const target = resolveCdTarget(subCmd, cwd);
			if (isCdToSubdirOrSame(subCmd, cwd) || (target && isPathInsideSkill(target, skillRoots))) {
				return true;
			}
		}

		// Read-only commands are allowed in both restricted modes.
		if (isReadonlyCommand(subCmd)) return true;

		// Trusted workflows may have side effects, so only auto-allow them in normal mode.
		if (currentMode === "normal" && isNormalAutoAllowedCommand(subCmd)) return true;

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
			const matching = MODE_CYCLE.filter((mode) => mode.startsWith(prefix));
			return matching.length > 0 ? matching.map((mode) => ({ value: mode, label: mode })) : null;
		},
		handler: async (args, ctx) => {
			const arg = args?.trim();

			if (!arg) {
				// Show interactive selector
				const choice = await ctx.ui.select(
					`Current working mode: ${currentMode}\n\nSelect mode:`,
					[
						"🔒 readonly  — only read-only commands allowed",
						"⚡ normal    — read-only and trusted workflows auto-allowed",
						"💀 berserker — no restrictions",
					],
				);
				if (!choice) return;
				if (choice.startsWith("🔒")) setMode("readonly", ctx);
				else if (choice.startsWith("⚡")) setMode("normal", ctx);
				else if (choice.startsWith("💀")) setMode("berserker", ctx);
				return;
			}

			const mode = parseMode(arg);
			if (mode) setMode(mode, ctx);
			else ctx.ui.notify(`Unknown mode "${arg}". Options: readonly | normal | berserker`, "error");
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

		if (!isToolCallEventType("bash", event)) return undefined;

		const rawCommand = event.input.command;
		const cwd = ctx.cwd;

		// Berserker: unconditional pass-through
		if (currentMode === "berserker") return undefined;

		// Decompose the command while tracking cwd changes that persist in the
		// current shell. This lets `cd <skill> && ./scripts/foo` resolve correctly.
		const subCommands = splitIntoSubcommands(rawCommand);
		const nonAllowed: string[] = [];
		let effectiveCwd = cwd;
		let commandChanged = false;

		for (let i = 0; i < subCommands.length; i++) {
			const subCommand = subCommands[i];
			if (currentMode === "readonly" && isSafeSedCommand(subCommand.command)) {
				const sandboxed = sandboxSedCommand(subCommand.command);
				commandChanged ||= sandboxed !== subCommand.command;
				subCommand.command = sandboxed;
			}
			if (!isAutoAllowed(subCommand.command, effectiveCwd)) nonAllowed.push(subCommand.command);

			const cdTarget = resolveCdTarget(subCommand.command, effectiveCwd);
			const nextOperator = subCommands[i + 1]?.operatorBefore;
			const cdRunsInPipeline = subCommand.operatorBefore === "|" || nextOperator === "|";
			if (cdTarget && !cdRunsInPipeline && nextOperator !== "||") effectiveCwd = cdTarget;
		}

		// All sub-commands are auto-allowed. Preserve their operators if sed was rewritten.
		if (nonAllowed.length === 0) {
			if (commandChanged) {
				event.input.command = subCommands
					.map(({ command, operatorBefore }) => operatorBefore ? `${operatorBefore} ${command}` : command)
					.join(" ");
			}
			return undefined;
		}

		// ── Read-only mode: hard block ────────────────────────────────────

		if (currentMode === "readonly") {
			return {
				block: true,
				reason: [
					"Command blocked by the user's working mode: read-only.",
					"",
					"The user has set the working session to read-only, so commands that can potentially write files are blocked.",
					"This command cannot be executed regardless of how you ask; only the user can change the working mode.",
					"",
					"Blocked sub-command(s):",
					...nonAllowed.map((c) => `  • ${c}`),
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

		// Escape
		if (!choice) {
			return { block: true, reason: "Blocked by user (working mode)" };
		}

		// Block with optional reason
		if (choice.startsWith("🚫")) {
			const reason = await ctx.ui.input("Reason (optional):", "type a reason (or just Enter to skip)");
			return {
				block: true,
				reason: reason?.trim() ? `Blocked by user: ${reason.trim()}` : "Blocked by user (working mode)",
			};
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

	pi.on("before_agent_start", (event) => {
		skillRoots = [...new Set((event.systemPromptOptions.skills ?? []).map((skill) => skill.baseDir))];

		if (currentMode === "readonly") {
			return {
				systemPrompt:
					event.systemPrompt +
					"\n\n[WORKING MODE: read-only]\n" +
					"You may only use read-only bash commands (grep, rg, find, cat, ls, git status, git log, " +
					"git diff, etc.).  The edit and write tools are disabled.\n" +
					"Do NOT attempt to create, modify, or delete files.",
			};
		}
		// Normal and berserker modes share the same prompt to preserve the model cache.
		return undefined;
	});

	// ── Session start / restore ──────────────────────────────────────────────

	pi.on("session_start", (_event, ctx) => {
		let initialMode = parseMode(pi.getFlag("wmode")) ?? "normal";
		const stateEntry = ctx.sessionManager
			.getBranch()
			.findLast((entry) => entry.type === "custom" && entry.customType === "working-mode-state") as
			| { data?: { mode?: unknown } }
			| undefined;
		initialMode = parseMode(stateEntry?.data?.mode) ?? initialMode;

		// Note: session-accepted patterns are intentionally NOT restored —
		// they are per-session-runtime, not persisted.

		currentMode = initialMode;
		applyModeTools(initialMode);
		updateStatus(ctx);
	});
}
