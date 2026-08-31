/**
 * Working Mode — utilities
 * Command parsing, path checks, and pattern matching.
 */

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, normalize, relative, resolve, sep } from "node:path";

// ─── Shell command splitting ─────────────────────────────────────────────────

/**
 * Split a (possibly compound) shell command into individual sub-commands.
 * Splits on: |, ||, &&, ;, \n
 * Respects single and double quoted strings and backslash escapes.
 *
 * Each result keeps the operator that preceded it so callers can track
 * stateful shell operations such as `cd skill && ./scripts/tool`.
 */
export type ShellOperator = "|" | "||" | "&&" | ";" | "\n";

export interface ShellSubcommand {
	command: string;
	operatorBefore?: ShellOperator;
}

export function splitIntoSubcommands(command: string): ShellSubcommand[] {
	const results: ShellSubcommand[] = [];
	let current = "";
	let operatorBefore: ShellOperator | undefined;
	let inSingle = false;
	let inDouble = false;
	let i = 0;

	const push = (nextOperator?: ShellOperator) => {
		if (current.trim()) results.push({ command: current.trim(), operatorBefore });
		current = "";
		operatorBefore = nextOperator;
	};

	while (i < command.length) {
		const ch = command[i];

		// Track quotes
		if (ch === "'" && !inDouble) {
			inSingle = !inSingle;
			current += ch;
			i++;
			continue;
		}
		if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
			current += ch;
			i++;
			continue;
		}
		// Backslash escape (outside single quotes)
		if (ch === "\\" && !inSingle && i + 1 < command.length) {
			current += ch + command[i + 1];
			i += 2;
			continue;
		}

		if (!inSingle && !inDouble) {
			// Two-character operators must be checked before a single pipe.
			if (ch === "|" && command[i + 1] === "|") {
				push("||");
				i += 2;
				continue;
			}
			if (ch === "&" && command[i + 1] === "&") {
				push("&&");
				i += 2;
				continue;
			}
			if (ch === "|" || ch === ";" || ch === "\n") {
				push(ch as "|" | ";" | "\n");
				i++;
				continue;
			}
		}

		current += ch;
		i++;
	}

	push();
	return results;
}

// ─── Read-only pattern detection ────────────────────────────────────────────

/**
 * Strip transparent command prefixes before the real command name.
 * Handles:
 *   - environment variable assignments  (FOO=bar cmd)
 *   - `time`  prefix  (time cmd)
 *   - `nohup` prefix  (nohup cmd)
 * Does NOT strip `sudo` (that's deliberately non-transparent).
 */
const TRANSPARENT_PREFIX_RE = /^(?:(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]*)\s+|time\s+|nohup\s+)*/;

/**
 * Read-only commands that are unconditionally safe in any mode.
 * Patterns are matched against the command after stripping transparent prefixes.
 */
const READONLY_PATTERNS: RegExp[] = [
	/^\s*(?:cat|head|tail|less|more|bat)\b/,
	/^\s*(?:grep|rg|ripgrep|fgrep|egrep|fd|find)\b/,
	/^\s*(?:ls|eza|exa|lsd|tree)\b/,
	/^\s*(?:wc|nl|sort|uniq|cut|tr|paste|column|awk|jq|yq|xargs)\b/,
	/^\s*sed\s+-n\b/i,
	/^\s*(?:diff|colordiff|delta)\b/,
	/^\s*(?:pwd|echo|printf|env|printenv|uname|whoami|id|date|cal|uptime|hostname|which|whereis|type|file|stat)\b/,
	/^\s*(?:du|df|ps|top|htop|btop|free|lsof|lscpu|lsblk)\b/,

	// Exact version checks: don't allow `node script.js --version`.
	/^\s*(?:node|python[23]?|ruby|rustc|cargo)\s+(?:--version|-v|-V)\s*$/i,
	/^\s*go\s+version\s*$/i,

	// git — read-only operations (`git -C PATH ...` supported)
	/^\s*git\s+(?:-C\s+(?:"[^"]+"|'[^']+'|\S+)\s+)?(?:status|log|diff|show|describe|shortlog|blame|check-ignore|rev-parse|rev-list)\b/i,
	/^\s*git\s+(?:-C\s+(?:"[^"]+"|'[^']+'|\S+)\s+)?ls-/i,
	/^\s*git\s+(?:-C\s+(?:"[^"]+"|'[^']+'|\S+)\s+)?stash\s+list\b/i,
	/^\s*git\s+(?:-C\s+(?:"[^"]+"|'[^']+'|\S+)\s+)?config\s+--(?:get|list)\b/i,

	// Package metadata queries. Mutating --fix variants are excluded.
	/^\s*npm\s+(?!.*--fix\b)(?:list|ls|view|info|search|outdated|audit)\b/i,
	/^\s*yarn\s+(?!.*--fix\b)(?:list|info|why|audit)\b/i,
	/^\s*pnpm\s+(?!.*--fix\b)(?:list|ls|info|audit)\b/i,

	/^\s*(?:true|false|sleep|man|tldr|help)\b/,
	/^\s*test\s/,
	/^\s*\[\s/,
];

/** Commands trusted in normal mode even though they may have side effects. */
const NORMAL_AUTO_PATTERNS: RegExp[] = [
	// Repository updates
	/^\s*git\s+(?:-C\s+(?:"[^"]+"|'[^']+'|\S+)\s+)?fetch\b/i,

	// Test and check commands
	/^\s*npm\s+(?:test|run\s+test)\b/i,
	/^\s*yarn\s+test\b/i,
	/^\s*pnpm\s+test\b/i,
	/^\s*pytest\b/,
	/^\s*python[23]?\s+-m\s+pytest\b/i,
	/^\s*cargo\s+(?:test|check|clippy)\b/i,
	/^\s*go\s+(?:test|vet)\b/i,
	/^\s*make\s+test\b/i,

	// Network commands can write files or mutate remote state depending on flags.
	/^\s*(?:curl|wget|http)\b/,

	// Explicitly trusted project workflows
	/^\s*just\s+(?:fix|check|test)\b/,
	/^\s*uv\s+run\s+ruff\s+(?:format|check)\b/,
	/^\s*uv\s+run\s+ty\s+check\b/,
];

/**
 * Returns true if `cmd` matches any read-only pattern.
 * Transparent prefixes (env vars, `time`, `nohup`) are stripped first.
 */
export function isReadonlyCommand(cmd: string): boolean {
	const stripped = cmd.trim().replace(TRANSPARENT_PREFIX_RE, "");
	return READONLY_PATTERNS.some((p) => p.test(stripped));
}

/** Returns true for commands trusted without confirmation only in normal mode. */
export function isNormalAutoAllowedCommand(cmd: string): boolean {
	const stripped = cmd.trim().replace(TRANSPARENT_PREFIX_RE, "");
	return NORMAL_AUTO_PATTERNS.some((p) => p.test(stripped));
}

// ─── Skill scripts ──────────────────────────────────────────────────────────

const SCRIPT_INTERPRETERS = new Set([
	"bash",
	"bun",
	"fish",
	"node",
	"perl",
	"php",
	"python",
	"python2",
	"python3",
	"ruby",
	"sh",
	"zsh",
]);

function shellWords(command: string): string[] {
	const words: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;

	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (ch === "\\" && quote !== "'" && i + 1 < command.length) {
			current += command[++i];
		} else if ((ch === "'" || ch === '"') && (!quote || quote === ch)) {
			quote = quote ? undefined : ch;
		} else if (/\s/.test(ch) && !quote) {
			if (current) words.push(current);
			current = "";
		} else {
			current += ch;
		}
	}
	if (current) words.push(current);
	return words;
}

function realPath(path: string): string | undefined {
	try {
		return realpathSync(path);
	} catch {
		return undefined;
	}
}

function isInside(path: string, parent: string, includeParent = true): boolean {
	const rel = relative(parent, path);
	return (
		(includeParent && rel === "") ||
		(rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
	);
}

function expandHome(path: string): string {
	return path === "~" ? homedir() : path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path;
}

/** Return true when path is the root or a descendant of a loaded skill. */
export function isPathInsideSkill(path: string, skillRoots: readonly string[]): boolean {
	const actualPath = realPath(path);
	if (!actualPath) return false;
	return skillRoots.some((root) => {
		const actualRoot = realPath(root);
		return actualRoot ? isInside(actualPath, actualRoot) : false;
	});
}

/** Return true when command directly executes a file under a loaded skill's scripts directory. */
export function isSkillScriptCommand(command: string, cwd: string, skillRoots: readonly string[]): boolean {
	const words = shellWords(command.trim().replace(TRANSPARENT_PREFIX_RE, ""));
	if (words.length === 0) return false;

	let script = words[0];
	const executable = basename(script);
	if (SCRIPT_INTERPRETERS.has(executable)) {
		if (words.length < 2 || words[1].startsWith("-")) return false;
		script = words[1];
	} else if (executable === "env") {
		const interpreter = words[1] ? basename(words[1]) : "";
		if (!SCRIPT_INTERPRETERS.has(interpreter) || !words[2] || words[2].startsWith("-")) return false;
		script = words[2];
	}

	const actualScript = realPath(resolve(cwd, expandHome(script)));
	if (!actualScript) return false;

	return skillRoots.some((root) => {
		const scriptsDir = realPath(resolve(root, "scripts"));
		return scriptsDir ? isInside(actualScript, scriptsDir, false) : false;
	});
}

// ─── cd special-case ────────────────────────────────────────────────────────

/**
 * Returns true if the command is a `cd` into the current directory or one of
 * its subdirectories (i.e. it never navigates "up" or "away").
 *
 * @param cmd  A single sub-command string.
 * @param cwd  The current working directory (absolute path).
 */
export function resolveCdTarget(cmd: string, cwd: string): string | undefined {
	const words = shellWords(cmd);
	if (words.length !== 2 || words[0] !== "cd" || words[1].startsWith("$")) return undefined;
	return resolve(cwd, expandHome(words[1]));
}

export function isCdToSubdirOrSame(cmd: string, cwd: string): boolean {
	const target = resolveCdTarget(cmd, cwd);
	if (!target) return false;

	const cwdNorm = normalize(cwd);
	return target === cwdNorm || target.startsWith(cwdNorm + sep);
}

// ─── Session-accepted pattern matching ──────────────────────────────────────

/**
 * Returns true if `cmd` matches the session-accepted `pattern`.
 * Patterns may use `*` as a wildcard that matches any sequence of characters.
 *
 * Matching is case-sensitive and anchored to the full trimmed command.
 */
export function matchesSessionPattern(cmd: string, pattern: string): boolean {
	// Escape all regex special chars except *, then replace * with .*
	const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
	try {
		return new RegExp(`^${escaped}$`).test(cmd.trim());
	} catch {
		return false;
	}
}

// ─── Pattern suggestion ──────────────────────────────────────────────────────

/**
 * Suggest a wildcard session pattern for a command.
 *
 * For compound commands (git, npm, docker, …) with ≥3 tokens:
 *   "git commit -m 'msg'" → "git commit *"
 *
 * For everything else with ≥2 tokens:
 *   "rm -rf /"  → "rm *"
 *
 * Single-token commands are returned as-is.
 */
const COMPOUND_COMMANDS = new Set([
	"git",
	"npm",
	"yarn",
	"pnpm",
	"cargo",
	"go",
	"python",
	"python3",
	"python2",
	"node",
	"make",
	"docker",
	"docker-compose",
	"kubectl",
	"helm",
	"terraform",
	"ansible",
	"pip",
	"pip3",
	"brew",
	"apt",
	"apt-get",
	"yum",
	"dnf",
	"pacman",
]);

// ─── Variable assignment detection ────────────────────────────────────────────

/**
 * Returns true if cmd is a pure shell variable assignment (or export) that
 * contains no command execution (backticks or $(...)).
 *
 * Accepted forms (no command substitution):
 *   VAR=value
 *   VAR+=value
 *   export VAR=value
 *   export VAR            (re-export of an already-set variable)
 *   A=1 B=2               (multiple assignments on one line)
 *
 * Rejected:
 *   FOO=$(date)           — command substitution via $(...)
 *   BAR=`date`            — command substitution via backticks
 */
export function isVarAssignment(cmd: string): boolean {
	const trimmed = cmd.trim();
	if (!trimmed) return false;

	// Reject any command substitution
	if (trimmed.includes("`") || /\$\(/.test(trimmed)) {
		return false;
	}

	const hasExport = /^export\s/.test(trimmed);
	let remaining = hasExport ? trimmed.replace(/^export\s+/, "").trim() : trimmed;

	// Each token must be VARNAME=value (with optional +? prefix before =).
	// When `export` is present, a bare VARNAME (no =) is also valid.
	const VAR_WITH_VALUE =
		/^[A-Za-z_][A-Za-z0-9_]*[+?]?=(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^ \t]*)/;
	const VAR_NAME_ONLY = /^[A-Za-z_][A-Za-z0-9_]*/;

	let hasAssignment = false;

	while (remaining.length > 0) {
		const m = remaining.match(VAR_WITH_VALUE);
		if (m) {
			hasAssignment = true;
			remaining = remaining.slice(m[0].length).trimStart();
			continue;
		}
		if (hasExport) {
			const n = remaining.match(VAR_NAME_ONLY);
			if (n) {
				remaining = remaining.slice(n[0].length).trimStart();
				continue;
			}
		}
		// Token didn't match any valid assignment form
		return false;
	}

	// Without export there must be at least one VAR=value token
	return hasExport || hasAssignment;
}

// ─── Pattern suggestion ──────────────────────────────────────────────────────

export function suggestPattern(cmd: string): string {
	const trimmed = cmd.trim();
	const parts = trimmed.split(/\s+/);
	if (parts.length <= 1) return trimmed;

	if (COMPOUND_COMMANDS.has(parts[0]) && parts.length > 2) {
		return `${parts[0]} ${parts[1]} *`;
	}
	return `${parts[0]} *`;
}
