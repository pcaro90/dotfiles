/**
 * Working Mode — utilities
 * Pure functions for command parsing and pattern matching.
 */

import { normalize, resolve, sep } from "node:path";

// ─── Shell command splitting ─────────────────────────────────────────────────

/**
 * Split a (possibly compound) shell command into individual sub-commands.
 * Splits on: |, ||, &&, ;, \n
 * Respects single and double quoted strings and backslash escapes.
 *
 * Examples:
 *   "ls && rm -rf /"  →  ["ls", "rm -rf /"]
 *   "grep foo | wc"   →  ["grep foo", "wc"]
 *   "echo 'a|b'; ls"  →  ["echo 'a|b'", "ls"]
 */
export function splitIntoSubcommands(command: string): string[] {
	const results: string[] = [];
	let current = "";
	let inSingle = false;
	let inDouble = false;
	let i = 0;

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
			// || (logical OR — must be checked before single |)
			if (ch === "|" && command[i + 1] === "|") {
				if (current.trim()) results.push(current.trim());
				current = "";
				i += 2;
				continue;
			}
			// && (logical AND)
			if (ch === "&" && command[i + 1] === "&") {
				if (current.trim()) results.push(current.trim());
				current = "";
				i += 2;
				continue;
			}
			// | (pipe)
			if (ch === "|") {
				if (current.trim()) results.push(current.trim());
				current = "";
				i++;
				continue;
			}
			// ; (statement separator)
			if (ch === ";") {
				if (current.trim()) results.push(current.trim());
				current = "";
				i++;
				continue;
			}
			// \n (newline as statement separator)
			if (ch === "\n") {
				if (current.trim()) results.push(current.trim());
				current = "";
				i++;
				continue;
			}
		}

		current += ch;
		i++;
	}

	if (current.trim()) results.push(current.trim());
	return results.filter((s) => s.length > 0);
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
	// Basic file/text reading
	/^\s*cat\b/,
	/^\s*head\b/,
	/^\s*tail\b/,
	/^\s*less\b/,
	/^\s*more\b/,
	/^\s*bat\b/,

	// Search
	/^\s*grep\b/,
	/^\s*rg\b/,
	/^\s*ripgrep\b/,
	/^\s*fgrep\b/,
	/^\s*egrep\b/,
	/^\s*fd\b/,
	/^\s*find\b/,

	// Directory listing
	/^\s*ls\b/,
	/^\s*eza\b/,
	/^\s*exa\b/,
	/^\s*lsd\b/,
	/^\s*tree\b/,

	// Text processing (read-only operations)
	/^\s*wc\b/,
	/^\s*nl\b/,
	/^\s*sort\b/,
	/^\s*uniq\b/,
	/^\s*cut\b/,
	/^\s*tr\b/,
	/^\s*paste\b/,
	/^\s*column\b/,
	/^\s*awk\b/,
	/^\s*jq\b/,
	/^\s*yq\b/,
	/^\s*xargs\b/,
	// sed -n is read-only; sed without -n may modify files
	/^\s*sed\s+-n\b/i,

	// Diff / comparison
	/^\s*diff\b/,
	/^\s*colordiff\b/,
	/^\s*delta\b/,

	// Shell / system info
	/^\s*pwd\b/,
	/^\s*echo\b/,
	/^\s*printf\b/,
	/^\s*env\b/,
	/^\s*printenv\b/,
	/^\s*uname\b/,
	/^\s*whoami\b/,
	/^\s*id\b/,
	/^\s*date\b/,
	/^\s*cal\b/,
	/^\s*uptime\b/,
	/^\s*hostname\b/,
	/^\s*which\b/,
	/^\s*whereis\b/,
	/^\s*type\b/,
	/^\s*file\b/,
	/^\s*stat\b/,

	// Disk / process info
	/^\s*du\b/,
	/^\s*df\b/,
	/^\s*ps\b/,
	/^\s*top\b/,
	/^\s*htop\b/,
	/^\s*btop\b/,
	/^\s*free\b/,
	/^\s*lsof\b/,
	/^\s*lscpu\b/,
	/^\s*lsblk\b/,

	// Version checks
	/^\s*node\b.*--version\b/i,
	/^\s*python[23]?\s+--version\b/i,
	/^\s*ruby\s+--version\b/i,
	/^\s*go\s+version\b/i,
	/^\s*rustc\s+--version\b/i,
	/^\s*cargo\s+--version\b/i,

	// git — read-only operations
	/^\s*git\s+(?:status|log|diff|show|branch|remote|fetch|describe|shortlog|blame|tag|check-ignore|rev-parse|rev-list)\b/i,
	/^\s*git\s+ls-/i,
	/^\s*git\s+stash\s+list\b/i,
	/^\s*git\s+config\s+--(?:get|list)\b/i,

	// npm / yarn / pnpm — listing / querying only
	/^\s*npm\s+(?:list|ls|view|info|search|outdated|audit)\b/i,
	/^\s*npm\s+(?:test|run\s+test)\b/i,
	/^\s*yarn\s+(?:list|info|why|audit|test)\b/i,
	/^\s*pnpm\s+(?:list|ls|info|audit|test)\b/i,

	// Test runners
	/^\s*pytest\b/,
	/^\s*python[23]?\s+-m\s+pytest\b/i,
	/^\s*cargo\s+test\b/i,
	/^\s*cargo\s+check\b/i,
	/^\s*cargo\s+clippy\b/i,
	/^\s*go\s+test\b/i,
	/^\s*go\s+vet\b/i,
	/^\s*make\s+test\b/i,

	// Network (read-only fetching)
	/^\s*curl\b/,
	/^\s*wget\b/,
	/^\s*http\b/, // httpie

	// Shell flow utilities (no side effects)
	/^\s*true\b/,
	/^\s*false\b/,
	/^\s*test\s/,
	/^\s*\[\s/,
	/^\s*sleep\b/,

	// Documentation
	/^\s*man\b/,
	/^\s*tldr\b/,
	/^\s*help\b/,

    // Just commands
	/^\s*just\s+fix\b/,
	/^\s*just\s+check\b/,
	/^\s*just\s+test\b/,
];

/**
 * Returns true if `cmd` matches any read-only pattern.
 * Transparent prefixes (env vars, `time`, `nohup`) are stripped first.
 */
export function isReadonlyCommand(cmd: string): boolean {
	const stripped = cmd.trim().replace(TRANSPARENT_PREFIX_RE, "");
	return READONLY_PATTERNS.some((p) => p.test(stripped));
}

// ─── cd special-case ────────────────────────────────────────────────────────

/**
 * Returns true if the command is a `cd` into the current directory or one of
 * its subdirectories (i.e. it never navigates "up" or "away").
 *
 * @param cmd  A single sub-command string.
 * @param cwd  The current working directory (absolute path).
 */
export function isCdToSubdirOrSame(cmd: string, cwd: string): boolean {
	const match = cmd.trim().match(/^cd\s+(.+?)$/);
	if (!match) {
		// Bare `cd` → goes to $HOME, which is not guaranteed to be a subdirectory.
		return false;
	}

	let target = match[1].trim();

	// Strip surrounding quotes
	target = target.replace(/^(['"])(.*)\1$/, "$2");

	// ~ refers to home directory — not necessarily a subdirectory of cwd
	if (target === "~" || target.startsWith("~/") || target.startsWith("$HOME")) {
		return false;
	}

	const resolved = resolve(cwd, target);
	const cwdNorm = normalize(cwd);

	// Must be exactly cwd, or a proper subdirectory (starts with cwd + sep)
	return resolved === cwdNorm || resolved.startsWith(cwdNorm + sep);
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
