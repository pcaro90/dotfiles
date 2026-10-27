import { existsSync, readFileSync, readdirSync, realpathSync, statSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const CONFIG_PATH = fileURLToPath(new URL("./config.json", import.meta.url));
export interface EnvironmentConfig {
	toolchain: { includePath: boolean; roots: string[] };
	sshAgentSocket: string | null;
}
const runtimeFiles = [
	"/etc/ld.so.cache", "/etc/ld.so.conf", "/etc/ld.so.conf.d", "/etc/resolv.conf", "/etc/hosts",
	"/etc/nsswitch.conf", "/etc/passwd", "/etc/group", "/etc/localtime", "/etc/ssl/certs",
	"/etc/ca-certificates", "/etc/pki", "/etc/alternatives",
];
const systemAliases = new Set(["/bin", "/sbin", "/lib", "/lib64"]);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const absoluteOrHome = (value: unknown): value is string => typeof value === "string" && !value.includes("\0")
	&& (isAbsolute(value) || value === "~" || value.startsWith("~/"));
export function expandConfiguredPath(path: string, home = homedir()): string {
	return path === "~" ? home : path.startsWith("~/") ? resolve(home, path.slice(2)) : resolve(path);
}
export function parseConfig(value: unknown, source = CONFIG_PATH): EnvironmentConfig {
	const fail = (message: string): never => { throw new Error(`Invalid Environment config (${source}): ${message}`); };
	if (!object(value)) return fail("expected a JSON object");
	if (Object.keys(value).some((key) => !["toolchain", "sshAgentSocket"].includes(key))) return fail("unknown configuration key");
	const toolchain = value.toolchain;
	if (!object(toolchain)) return fail("toolchain must be an object");
	if (Object.keys(toolchain).some((key) => !["includePath", "roots"].includes(key))) return fail("unknown toolchain key");
	if (toolchain.includePath !== undefined && typeof toolchain.includePath !== "boolean") return fail("toolchain.includePath must be boolean");
	if (!Array.isArray(toolchain.roots) || !toolchain.roots.every(absoluteOrHome)) return fail("toolchain.roots must contain absolute or ~/ paths");
	if (value.sshAgentSocket !== undefined && value.sshAgentSocket !== null && !absoluteOrHome(value.sshAgentSocket)) return fail("sshAgentSocket must be an absolute path, ~/ path, or null");
	return {
		toolchain: { includePath: toolchain.includePath !== false, roots: [...toolchain.roots] },
		sshAgentSocket: value.sshAgentSocket as string | null | undefined ?? null,
	};
}
export function loadConfig(path = CONFIG_PATH): EnvironmentConfig {
	let content: string;
	try { content = readFileSync(path, "utf8"); }
	catch (error) { throw new Error(`Cannot read Environment config (${path}): ${error instanceof Error ? error.message : String(error)}`); }
	let parsed: unknown;
	try { parsed = JSON.parse(content); }
	catch (error) { throw new Error(`Invalid JSON in Environment config (${path}): ${error instanceof Error ? error.message : String(error)}`); }
	return parseConfig(parsed, path);
}
export function inside(path: string, parent: string): boolean {
	const rel = relative(parent, path);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
/** Remove covered entries without resolving lexical aliases such as /etc/localtime. */
export function compactReadPaths(paths: string[]): string[] {
	const unique = [...new Set(paths.map((path) => resolve(path)))];
	return unique.filter((p) => !unique.some((parent) => parent !== p && inside(p, parent)));
}
export function defaultReadPaths(home = homedir(), path = process.env.PATH ?? "", config = loadConfig()): string[] {
	const bins = config.toolchain.includePath ? path.split(":").filter((p) => isAbsolute(p) && p !== home && p !== "/") : [];
	const candidates = [...runtimeFiles, ...config.toolchain.roots.map((p) => expandConfiguredPath(p, home)), ...bins];
	for (const bin of bins) {
		let entries: Dirent[];
		try { entries = readdirSync(bin, { withFileTypes: true }); } catch { continue; }
		for (const entry of entries) {
			if (!entry.isSymbolicLink()) continue;
			// One dangling/unreadable link must not abort discovery of the rest of PATH.
			try {
				const target = realpathSync(resolve(bin, entry.name));
				if (statSync(target).isFile() && (statSync(target).mode & 0o111)) candidates.push(target);
			} catch { /* Optional or broken PATH entry. */ }
		}
	}
	return compactReadPaths(candidates.filter((p) => existsSync(p) && !systemAliases.has(p)));
}
/** Defined (even empty/stale) SSH_AUTH_SOCK wins. Never silently switch identities. */
export function selectAgentSocket(env: NodeJS.ProcessEnv = process.env, config?: EnvironmentConfig, home = homedir()): string | undefined {
	if (env.SSH_AUTH_SOCK !== undefined) return env.SSH_AUTH_SOCK;
	const fallback = (config ?? loadConfig()).sshAgentSocket;
	return fallback === null ? undefined : expandConfiguredPath(fallback, home);
}
