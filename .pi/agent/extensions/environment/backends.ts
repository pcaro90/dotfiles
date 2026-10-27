import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, posix, resolve } from "node:path";
import type { EnvironmentState, Remote } from "./state.js";
import { canonicalPath, expandPath, inside } from "./state.js";
import { checked, runProcess, shellQuote as q, type RunOptions, type RunResult } from "./process.js";
import { selectAgentSocket } from "./config.js";

export interface Backend {
	key: string;
	cwd: string;
	run(command: string, options?: RunOptions): Promise<RunResult>;
	assertAccess?(path: string, write: boolean): void;
}
export interface Mount { path: string; source: string; access: "ro" | "rw"; private?: boolean }
const aliases: Record<string, string> = { "/bin": "usr/bin", "/sbin": "usr/bin", "/lib": "usr/lib", "/lib64": "usr/lib", "/var/run": "../run" };

export const BUBBLE_AGENT_SOCKET = "/run/environment/ssh-agent.sock";
interface SocketSources { agent?: string; docker?: string }
function socketSources(): SocketSources { return { agent: selectAgentSocket(), docker: dockerSocket() }; }
/** The SSH broker may use the agent without granting the socket to the bubble. */
export function sshEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const env = { ...process.env, ...extra };
	const agent = selectAgentSocket(env);
	if (agent !== undefined) env.SSH_AUTH_SOCK = agent;
	return env;
}
export function dockerSocket(): string | undefined {
	const configured = process.env.DOCKER_HOST;
	const paths = configured?.startsWith("unix://") ? [configured.slice(7)] : [
		`/run/user/${process.getuid?.() ?? 1000}/docker.sock`, resolve(homedir(), ".docker/run/docker.sock"), "/var/run/docker.sock",
	];
	return paths.find((p) => existsSync(p));
}
export function requireSocket(path: string | undefined, label: string): string {
	if (path === "" && label === "SSH agent") throw new Error("SSH_AUTH_SOCK is defined but empty; the configured fallback is not used.");
	if (!path) throw new Error(label === "SSH agent"
		? "SSH_AUTH_SOCK is not set in the Pi host process and no sshAgentSocket fallback is configured. Configure the socket in Environment's config.json. The bubble's environment is separate."
		: `${label}: no local socket was configured or found.`);
	if (!existsSync(path)) throw new Error(`${label}: the configured host socket does not exist: ${path}`);
	if (!statSync(path).isSocket()) throw new Error(`${label}: the configured host path is not a socket: ${path}`);
	return realpathSync(path);
}
export function privateHome(sessionId: string): string {
	const key = createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
	return `/tmp/pi-environment-${process.getuid?.() ?? "user"}/${key}/home`;
}
export function bubbleMounts(state: EnvironmentState, sessionId: string, skillRoots: string[], sockets = socketSources()): Mount[] {
	const mounts = new Map<string, Mount>();
	const pathAliases = { ...state.pathAliases }, skillTargets = new Set<string>();
	const add = (path: string, access: "ro" | "rw", source = path, privateMount = false) => {
		if (aliases[path]) return;
		if (!existsSync(source)) throw new Error(`Bubble resource is unavailable: ${source}. Review /env resources; execution was not redirected to the host.`);
		mounts.set(path, { path, source, access, ...(privateMount ? { private: true } : {}) });
	};
	const scratch = privateHome(sessionId);
	for (const p of [scratch, resolve(scratch, ".cache"), resolve(scratch, ".config"), resolve(scratch, ".local/share")]) mkdirSync(p, { recursive: true, mode: 0o700 });
	add(homedir(), "rw", scratch, true);
	for (const path of state.readPaths) add(path, "ro");
	// Automatic skill grants need the advertised aliases too, not only real paths hidden behind the private home.
	for (const root of skillRoots) {
		const requested = resolve(root), target = canonicalPath(requested);
		add(target, "ro"); skillTargets.add(target);
		if (requested !== target) pathAliases[requested] ??= target;
	}
	for (const path of state.writePaths) add(path, "rw");
	for (const [alias, target] of Object.entries(pathAliases)) {
		if (state.writePaths.includes(target)) add(alias, "rw", target);
		else if (state.readPaths.includes(target) || skillTargets.has(target)) add(alias, "ro", target);
	}
	if (state.sshAgent) add(BUBBLE_AGENT_SOCKET, "ro", requireSocket(sockets.agent, "SSH agent"));
	if (state.docker) {
		const socket = requireSocket(sockets.docker, "Docker");
		add(socket, "ro");
		const config = resolve(homedir(), ".docker");
		if (existsSync(config)) add(config, "ro");
	}
	const ordered = [...mounts.values()].sort((a, b) => a.path.split("/").length - b.path.split("/").length || a.path.localeCompare(b.path));
	const effective: Mount[] = [];
	for (const mount of ordered) {
		const parent = pathMount(effective, mount.path);
		// A granted alias in the synthetic home needs its own bind. In a mounted host
		// directory the original symlink already exists; its separately mounted target resolves it.
		if (parent && !parent.private && mount.source !== mount.path && pathAliases[mount.path] === mount.source) continue;
		// Avoid mounting on an existing symlink such as ~/.zvm/bin or /usr/lib/jvm/default/bin.
		if (parent && !parent.private && parent.access === mount.access && mount.source === mount.path) continue;
		effective.push(mount);
	}
	return effective;
}
function pathMount(mounts: Mount[], path: string): Mount | undefined {
	return mounts.filter((m) => inside(path, m.path)).sort((a, b) => b.path.length - a.path.length)[0];
}
export function bubbleEnvironment(state: EnvironmentState, sockets = socketSources()): NodeJS.ProcessEnv {
	const home = homedir();
	const env: NodeJS.ProcessEnv = {
		HOME: home, USER: process.env.USER ?? "user", LOGNAME: process.env.LOGNAME ?? process.env.USER ?? "user",
		PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", SHELL: "/bin/bash", TERM: process.env.TERM ?? "dumb",
		LANG: process.env.LANG ?? "C.UTF-8", TMPDIR: "/tmp", XDG_CACHE_HOME: resolve(home, ".cache"),
		XDG_CONFIG_HOME: resolve(home, ".config"), XDG_DATA_HOME: resolve(home, ".local/share"),
	};
	if (process.env.TZ) env.TZ = process.env.TZ;
	if (state.sshAgent) { requireSocket(sockets.agent, "SSH agent"); env.SSH_AUTH_SOCK = BUBBLE_AGENT_SOCKET; }
	if (state.docker) env.DOCKER_HOST = `unix://${requireSocket(sockets.docker, "Docker")}`;
	return env;
}
export function bubbleArguments(state: EnvironmentState, mounts: Mount[], command: string, sockets = socketSources()): string[] {
	const args = ["--unshare-all", "--unshare-user", "--share-net", "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--disable-userns", "--dir", "/run"];
	for (const [path, target] of Object.entries(aliases)) {
		if (existsSync(path) && lstatSync(path).isSymbolicLink()) args.push("--symlink", target, path);
	}
	for (const mount of mounts) args.push(mount.access === "rw" ? "--bind" : "--ro-bind", mount.source, mount.path);
	// /tmp is intentionally shared. Hide these known privileged sockets even if a broad grant exposes their parents.
	const hidden = [!state.sshAgent && sockets.agent, !state.docker && sockets.docker].filter((p): p is string => !!p);
	for (const socket of hidden) {
		if (!existsSync(socket)) continue;
		for (const path of new Set([socket, realpathSync(socket)])) {
			const mount = pathMount(mounts, path);
			if (mount && !mount.private) args.push("--ro-bind", "/dev/null", path);
		}
	}
	// Never expose the host's procfs/devices, including when the workspace is an ancestor of these paths.
	args.push("--proc", "/proc", "--dev", "/dev", "--chdir", state.localRoot, "--", "/bin/bash", "--noprofile", "--norc", "-c", command);
	return args;
}
export function bubbleBackend(state: EnvironmentState, sessionId: string, skillRoots: string[] = [], program = "bwrap"): Backend {
	const sockets = socketSources();
	const mounts = bubbleMounts(state, sessionId, skillRoots, sockets);
	return {
		key: `bubble:${state.localRoot}`, cwd: state.localRoot,
		assertAccess(path, write) {
			const canonical = canonicalPath(path);
			let lexical = pathMount(mounts, path);
			const actual = pathMount(mounts, canonical);
			// System aliases are explicitly created in the namespace, not mounted separately.
			if (!lexical && Object.keys(aliases).some((alias) => inside(path, alias))) lexical = actual;
			const allowed = (m: Mount | undefined) => m && (!write || m.access === "rw");
			// A file bind dereferences its source (e.g. /etc/localtime). Symlinks inside a
			// mounted directory still need an exposed destination; the OS is the final boundary.
			const withinSource = lexical && inside(canonical, canonicalPath(lexical.source));
			if (!allowed(lexical) || (!lexical?.private && !withinSource && !allowed(actual))) throw new Error(`Blocked by the current bubble: ${write ? "write" : "read"} access to ${path} is not granted. Ask the user with request_access for ${write ? "RW" : "RO"} access to this path or its parent.`);
		},
		async run(command, options = {}) {
			const env = bubbleEnvironment(state, sockets);
			// Pi's session metadata is useful; arbitrary host or shell-hook variables are not inherited.
			for (const key of ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"]) {
				const value = options.env?.[key]; if (value !== undefined) env[key] = value;
			}
			return runProcess(program, bubbleArguments(state, mounts, command, sockets), { ...options, cwd: "/", env });
		},
	};
}
export function directBackend(cwd: string): Backend {
	return { key: `direct:${cwd}`, cwd, run: (command, options = {}) => runProcess("/bin/bash", ["-c", command], { ...options, cwd, env: { ...process.env, ...options.env } }) };
}
export function parseSshTarget(input: string): { host: string; path?: string } {
	const match = input.match(/^((?:[^@:\s]+@)?\[[^\]]+\]|[^:\s]+)(?::(.*))?$/);
	if (!match || match[1].startsWith("-") || /[\x00-\x1f\x7f]/.test(input)) throw new Error("Expected user@host or user@host:/path (IPv6: user@[address]:/path).");
	return { host: match[1], ...(match[2] ? { path: match[2] } : {}) };
}
export function sshBackend(remote: Remote, program = "ssh"): Backend {
	return {
		key: `ssh:${remote.host}:${remote.cwd}`, cwd: remote.cwd,
		run(command, options = {}) {
			const script = `cd -- ${q(remote.cwd)} && ${command}`;
			return runProcess(program, ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", remote.host, `exec bash --noprofile --norc -c ${q(script)}`], { ...options, env: sshEnvironment(options.env) });
		},
	};
}
export async function resolveSshTarget(input: string, program = "ssh"): Promise<Remote> {
	const { host, path } = parseSshTarget(input);
	const target = path === "~" ? '"$HOME"' : path?.startsWith("~/") ? `"$HOME"/${q(path.slice(2))}` : path ? q(path) : '"$HOME"';
	const probe = `cd -- ${target} && printf '%s\\0%s' "$PWD" "$HOME"`;
	const result = await runProcess(program, ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", host, `exec bash --noprofile --norc -c ${q(probe)}`], { timeout: 15, env: sshEnvironment() });
	const [cwd, home] = checked(result, "SSH initialization failed; no local fallback").toString().split("\0");
	if (!cwd?.startsWith("/") || !home?.startsWith("/")) throw new Error("SSH initialization returned invalid working directory/home; execution remains blocked.");
	return { host, cwd, home };
}
export function remotePath(path: string, remote: Remote): string {
	const p = path.startsWith("@") ? path.slice(1) : path;
	return posix.resolve(remote.cwd, p === "~" ? remote.home : p.startsWith("~/") ? posix.join(remote.home, p.slice(2)) : p);
}
export function bubbleFailure(error: unknown): Error {
	const message = error instanceof Error ? error.message : String(error);
	if (/^(aborted|timeout:)/.test(message) || message.startsWith("Blocked by the current bubble:")) return new Error(message);
	return new Error(`Operation failed inside the current bubble: ${message}\nThe bubble may hide the path or deny writes; a missing file may also genuinely not exist. If additional resources are needed, ask the user with request_access. No host fallback was attempted.`);
}
export async function probeBubble(state: EnvironmentState, sessionId: string, skillRoots: string[] = []): Promise<void> {
	checked(await bubbleBackend(state, sessionId, skillRoots).run("true", { timeout: 10 }), "Bubble initialization failed; no host fallback");
}
export async function backendCapture(backend: Backend, command: string, options: RunOptions = {}): Promise<Buffer> {
	try { return checked(await backend.run(command, { timeout: 30, ...options }), backend.key); }
	catch (error) { if (backend.key.startsWith("bubble:")) throw bubbleFailure(error); throw error; }
}
