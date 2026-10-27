import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { compactReadPaths, CONFIG_PATH, defaultReadPaths } from "./config.js";
export { defaultReadPaths, inside } from "./config.js";

export const STATE_ENTRY = "environment-state";
export const MESSAGE_TYPE = "environment-change";
export type Mode = "bubble" | "direct" | "ssh";
export interface Remote { host: string; cwd: string; home: string }
export interface EnvironmentState {
	version: 1;
	mode: Mode;
	localRoot: string;
	remote: Remote | null;
	readPaths: string[];
	writePaths: string[];
	/** Last applied profile and explicit session grants, for non-destructive profile refresh. */
	profileReadPaths: string[];
	readGrants: string[];
	sshAgent: boolean;
	docker: boolean;
	mcpServers: string[];
	sshSkills: string[];
	omitDocs: boolean;
	/** Requested symlink names mapped to their explicitly granted canonical target. */
	pathAliases?: Record<string, string>;
}
export type Resource =
	| { type: "path"; path: string; access: "ro" | "rw" }
	| { type: "ssh_agent" }
	| { type: "docker" }
	| { type: "mcp"; server: string };

export function expandPath(path: string, cwd: string, home = homedir()): string {
	const p = path.startsWith("@") ? path.slice(1) : path;
	return resolve(cwd, p === "~" ? home : p.startsWith("~/") ? resolve(home, p.slice(2)) : p);
}
/** Resolve existing ancestors too, so a not-yet-created file cannot bypass a grant through a symlink. */
export function canonicalPath(path: string): string {
	try { return realpathSync(path); } catch (error: any) {
		if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
		const parent = dirname(path);
		return parent === path ? path : resolve(canonicalPath(parent), relative(parent, path));
	}
}
export function existingPath(path: string, cwd: string): string {
	const absolute = expandPath(path, cwd);
	if (!existsSync(absolute)) throw new Error(`Path does not exist: ${absolute}. Grant its existing parent directory instead.`);
	if (statSync(absolute).isSocket()) throw new Error("Use the SSH agent or Docker capability for their sockets, not a filesystem grant.");
	return realpathSync(absolute);
}
export function initialState(cwd: string, profile = defaultReadPaths()): EnvironmentState {
	return {
		version: 1, mode: "bubble", localRoot: realpathSync(cwd), remote: null,
		readPaths: [...profile], profileReadPaths: [...profile], readGrants: [], writePaths: [realpathSync(cwd), "/tmp"],
		sshAgent: false, docker: false, mcpServers: [], sshSkills: ["@documentation"], omitDocs: false,
	};
}
export function decodeState(value: unknown): EnvironmentState {
	const v = value as EnvironmentState;
	const strings = (x: unknown): x is string[] => Array.isArray(x) && x.every((s) => typeof s === "string" && !s.includes("\0"));
	if (!v || v.version !== 1 || !["bubble", "direct", "ssh"].includes(v.mode)
		|| typeof v.localRoot !== "string" || !isAbsolute(v.localRoot)
		|| ![v.readPaths, v.writePaths, v.profileReadPaths, v.readGrants, v.mcpServers, v.sshSkills].every(strings)
		|| ![...v.readPaths, ...v.writePaths, ...v.profileReadPaths, ...v.readGrants].every(isAbsolute)
		|| typeof v.sshAgent !== "boolean" || typeof v.docker !== "boolean" || typeof v.omitDocs !== "boolean"
		|| (v.pathAliases !== undefined && (!v.pathAliases || Array.isArray(v.pathAliases) || typeof v.pathAliases !== "object"
			|| !Object.entries(v.pathAliases).every(([alias, target]) => isAbsolute(alias) && typeof target === "string" && isAbsolute(target) && !alias.includes("\0") && !target.includes("\0"))))
		|| (v.remote !== null && (!v.remote || typeof v.remote.host !== "string" || !isAbsolute(v.remote.cwd) || !isAbsolute(v.remote.home)))
		|| (v.mode === "ssh" && !v.remote)) throw new Error("Invalid Environment state in this session; refusing to execute. Use /env reset to restore defaults.");
	return structuredClone(v);
}
export function restoreState(entries: readonly any[]): EnvironmentState | undefined {
	const snapshot = entries.findLast((e) => e.type === "custom" && e.customType === STATE_ENTRY);
	return snapshot && decodeState(snapshot.data);
}
export function refreshReadProfile(state: EnvironmentState, profile = defaultReadPaths()): EnvironmentState {
	const next = structuredClone(state);
	const grants = [...new Set([...state.readGrants, ...state.readPaths.filter((p) => !state.profileReadPaths.includes(p))])];
	next.profileReadPaths = [...profile];
	next.readGrants = grants;
	next.readPaths = compactReadPaths([...profile, ...grants].filter((p) => !state.writePaths.includes(p)));
	return next;
}
export function applyResource(state: EnvironmentState, resource: Resource, enabled = true): EnvironmentState {
	const next = structuredClone(state);
	const update = (items: string[], value: string) => enabled ? [...new Set([...items, value])] : items.filter((p) => p !== value);
	if (resource.type === "path") {
		const requested = expandPath(resource.path, state.localRoot);
		// Stale/missing mounts must still be revocable after a file or directory is removed.
		const path = enabled ? existingPath(resource.path, state.localRoot) : (state.pathAliases?.[requested] ?? (existsSync(requested) ? realpathSync(requested) : requested));
		if (enabled) {
			next.readPaths = next.readPaths.filter((p) => p !== path);
			next.writePaths = next.writePaths.filter((p) => p !== path);
		}
		if (resource.access === "ro") next.readPaths = update(next.readPaths, path).filter((p) => enabled || p !== requested);
		else next.writePaths = update(next.writePaths, path).filter((p) => enabled || p !== requested);
		if (resource.access === "ro") next.readGrants = update(next.readGrants, path).filter((p) => enabled || p !== requested);
		else if (enabled) next.readGrants = next.readGrants.filter((p) => p !== path && p !== requested);
		if (enabled && requested !== path) next.pathAliases = { ...next.pathAliases, [requested]: path };
		if (!enabled && next.pathAliases) next.pathAliases = Object.fromEntries(Object.entries(next.pathAliases).filter(([alias, target]) => alias !== requested && target !== path));
	} else if (resource.type === "ssh_agent") next.sshAgent = enabled;
	else if (resource.type === "docker") next.docker = enabled;
	else next.mcpServers = update(next.mcpServers, resource.server);
	return next;
}
export function describeResource(resource: Resource): string {
	switch (resource.type) {
		case "path": return `${resource.access.toUpperCase()} ${resource.path}`;
		case "ssh_agent": return "Personal SSH agent (all loaded identities)";
		case "docker": return "Docker (full access to the local daemon)";
		case "mcp": return `External MCP server: ${resource.server}`;
	}
}
export const MODE_ICONS: Record<Mode, string> = { bubble: "🫧", direct: "💻", ssh: "🌐" };
export function displayPath(path: string): string {
	const home = homedir();
	return path === home ? "~" : path.startsWith(home + "/") ? "~" + path.slice(home.length) : path;
}
export function target(state: EnvironmentState): string {
	return state.mode === "ssh" ? `${state.remote!.host}:${state.remote!.cwd}` : state.localRoot;
}
export function summary(state: EnvironmentState): string {
	return `${MODE_ICONS[state.mode]} ${state.mode === "ssh" ? target(state) : displayPath(state.localRoot)}`;
}
/** Compare effective policy, not set ordering or refresh/provenance bookkeeping. */
export function policyKey(state: EnvironmentState): string {
	const remote = state.mode === "ssh" ? state.remote : null;
	return JSON.stringify([state.mode, state.localRoot, remote?.host, remote?.cwd, remote?.home, state.sshAgent, state.docker,
		...[state.readPaths, state.writePaths, state.mcpServers, state.mode === "ssh" ? state.sshSkills : []].map((paths) => [...paths].sort()),
		Object.entries(state.pathAliases ?? {}).sort()]);
}
export function footerStatus(state: EnvironmentState, ready = true): string {
	if (!ready) return "⛔ /env";
	if (state.mode === "bubble") return `${MODE_ICONS.bubble}${state.sshAgent ? " 🔑" : ""}${state.docker ? " 🐳" : ""}`;
	return state.mode === "ssh" ? `${MODE_ICONS.ssh} ${target(state)}` : MODE_ICONS[state.mode];
}
/** Compact model context; full mount inventories belong in the explicit resource/status panel. */
export function stateMessage(state: EnvironmentState): string {
	const lines = [`Environment: ${state.mode.toUpperCase()} · ${target(state)}`];
	if (state.mode === "bubble") {
		lines.push(`RW: ${state.writePaths.join(", ") || "none"}. RO: ${state.readPaths.length} configured paths + local skills. Other host paths hidden; home/cache private; network open.`);
		lines.push(`SSH agent ${state.sshAgent ? "on" : "off"}; Docker ${state.docker ? "on" : "off"}; external MCP: ${state.mcpServers.join(", ") || "none"}.`);
		lines.push("If blocked, ask the user with request_access; do not switch modes to bypass a denial.");
	} else if (state.mode === "ssh") {
		lines.push(`Project tools and ! run remotely; AGENTS.md, selected skills and Pi artifacts remain local (${state.localRoot}). Local skill scripts use the local bubble; SSH skills: ${state.sshSkills.join(", ") || "none"}.`);
	} else lines.push("Local host execution, unrestricted by Environment.");
	lines.push("Access changes affect new executions only.");
	return lines.join("\n");
}
export function fullStatus(state: EnvironmentState): string {
	return `${stateMessage(state)}\nConfiguration: ${displayPath(CONFIG_PATH)}\n\nRO paths:\n${state.readPaths.map(displayPath).join("\n")}\n\nRW paths:\n${state.writePaths.map(displayPath).join("\n")}`
		+ (Object.keys(state.pathAliases ?? {}).length ? `\n\nAliases:\n${Object.entries(state.pathAliases!).map(([alias, target]) => `${displayPath(alias)} → ${displayPath(target)}`).join("\n")}` : "");
}
/** Parse slash-command arguments, not shell commands. No expansion or execution. */
export function commandWords(input: string): string[] {
	const words: string[] = []; let word = ""; let quote = ""; let active = false;
	for (let i = 0; i < input.length; i++) {
		const ch = input[i];
		if (ch === "\\" && quote !== "'") { if (++i >= input.length) throw new Error("Trailing backslash"); word += input[i]; active = true; }
		else if ((ch === "'" || ch === '"') && (!quote || quote === ch)) { quote = quote ? "" : ch; active = true; }
		else if (!quote && /\s/.test(ch)) { if (active) words.push(word); word = ""; active = false; }
		else { word += ch; active = true; }
	}
	if (quote) throw new Error("Unclosed quote");
	if (active) words.push(word);
	return words;
}
