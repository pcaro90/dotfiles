/**
 * SSH Remote Execution Example
 *
 * Demonstrates delegating tool operations to a remote machine via SSH.
 * When --ssh is provided, read/write/edit/bash run on the remote, except
 * reads and bash commands that target a loaded local skill.
 *
 * Usage:
 *   pi -e ./ssh.ts --ssh user@host
 *   pi -e ./ssh.ts --ssh user@host:/remote/path
 *
 * Requirements:
 *   - SSH key-based auth (no password prompts)
 *   - bash on remote
 */

import { spawn } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
import type { ExtensionAPI, Skill } from "@earendil-works/pi-coding-agent";
import {
	type BashOperations,
	createBashToolDefinition,
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type EditOperations,
	type ReadOperations,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";

function sshExec(remote: string, command: string): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const child = spawn("ssh", [remote, command], { stdio: ["ignore", "pipe", "pipe"] });
		const chunks: Buffer[] = [];
		const errChunks: Buffer[] = [];
		child.stdout.on("data", (data) => chunks.push(data));
		child.stderr.on("data", (data) => errChunks.push(data));
		child.on("error", reject);
		child.on("close", (code) => {
			if (code !== 0) {
				reject(new Error(`SSH failed (${code}): ${Buffer.concat(errChunks).toString()}`));
			} else {
				resolve(Buffer.concat(chunks));
			}
		});
	});
}

function createRemoteReadOps(remote: string, remoteCwd: string, localCwd: string): ReadOperations {
	const toRemote = (p: string) => p.replace(localCwd, remoteCwd);
	return {
		readFile: (p) => sshExec(remote, `cat ${JSON.stringify(toRemote(p))}`),
		access: (p) => sshExec(remote, `test -r ${JSON.stringify(toRemote(p))}`).then(() => {}),
		detectImageMimeType: async (p) => {
			try {
				const r = await sshExec(remote, `file --mime-type -b ${JSON.stringify(toRemote(p))}`);
				const m = r.toString().trim();
				return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(m) ? m : null;
			} catch {
				return null;
			}
		},
	};
}

function createRemoteWriteOps(remote: string, remoteCwd: string, localCwd: string): WriteOperations {
	const toRemote = (p: string) => p.replace(localCwd, remoteCwd);
	return {
		writeFile: async (p, content) => {
			const b64 = Buffer.from(content).toString("base64");
			await sshExec(remote, `echo ${JSON.stringify(b64)} | base64 -d > ${JSON.stringify(toRemote(p))}`);
		},
		mkdir: (dir) => sshExec(remote, `mkdir -p ${JSON.stringify(toRemote(dir))}`).then(() => {}),
	};
}

function createRemoteEditOps(remote: string, remoteCwd: string, localCwd: string): EditOperations {
	const r = createRemoteReadOps(remote, remoteCwd, localCwd);
	const w = createRemoteWriteOps(remote, remoteCwd, localCwd);
	return { readFile: r.readFile, access: r.access, writeFile: w.writeFile };
}

function createRemoteBashOps(remote: string, remoteCwd: string, localCwd: string): BashOperations {
	const toRemote = (p: string) => p.replace(localCwd, remoteCwd);
	return {
		exec: (command, cwd, { onData, signal, timeout }) =>
			new Promise((resolve, reject) => {
				const cmd = `cd ${JSON.stringify(toRemote(cwd))} && ${command}`;
				const child = spawn("ssh", [remote, cmd], { stdio: ["ignore", "pipe", "pipe"] });
				let timedOut = false;
				const timer = timeout
					? setTimeout(() => {
							timedOut = true;
							child.kill();
						}, timeout * 1000)
					: undefined;
				child.stdout.on("data", onData);
				child.stderr.on("data", onData);
				child.on("error", (e) => {
					if (timer) clearTimeout(timer);
					reject(e);
				});
				const onAbort = () => child.kill();
				signal?.addEventListener("abort", onAbort, { once: true });
				child.on("close", (code) => {
					if (timer) clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					if (signal?.aborted) reject(new Error("aborted"));
					else if (timedOut) reject(new Error(`timeout:${timeout}`));
					else resolve({ exitCode: code });
				});
			}),
	};
}

function isPathInside(path: string, parent: string): boolean {
	const rel = relative(parent, path);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function resolveToolPath(path: string, cwd: string): string {
	// Built-in file tools accept the display-oriented @/path form too.
	const normalized = path.startsWith("@") ? path.slice(1) : path;
	return resolve(cwd, normalized);
}

function commandReferencesPath(command: string, path: string): boolean {
	let index = command.indexOf(path);
	while (index !== -1) {
		const before = index === 0 ? "" : command[index - 1];
		const end = index + path.length;
		const after = end === command.length ? "" : command[end];
		const validBefore = before === "" || /[\s'"`=$({[;|&]/.test(before);
		const validAfter = after === "" || /[\\/\s'"`$)}\];|&]/.test(after);
		if (validBefore && validAfter) return true;
		index = command.indexOf(path, index + 1);
	}
	return false;
}

export default function (pi: ExtensionAPI) {
	// Shared inter-extension contract:
	// - emits "ssh:state" with { remote, remoteCwd } when SSH is active
	// - emits null when SSH is inactive
	// Consumers (e.g. working-mode) can adapt their active tool set accordingly.
	const SSH_STATE_EVENT = "ssh:state";

	pi.registerFlag("ssh", { description: "SSH remote: user@host or user@host:/path", type: "string" });

	const localCwd = process.cwd();
	const localRead = createReadToolDefinition(localCwd);
	const localWrite = createWriteToolDefinition(localCwd);
	const localEdit = createEditToolDefinition(localCwd);
	const localBash = createBashToolDefinition(localCwd);

	// Resolved lazily on session_start (CLI flags not available during factory)
	let resolvedSsh: { remote: string; remoteCwd: string } | null = null;
	let localSkillRoots: string[] = [];

	const getSsh = () => resolvedSsh;
	const updateLocalSkills = (skills: Skill[] | undefined) => {
		localSkillRoots = [...new Set((skills ?? []).map((skill) => resolve(skill.baseDir)))];
	};
	const isLocalSkillPath = (path: string) => {
		const absolutePath = resolveToolPath(path, localCwd);
		return localSkillRoots.some((root) => isPathInside(absolutePath, root));
	};
	const isLocalSkillCommand = (command: string) =>
		localSkillRoots.some((root) => commandReferencesPath(command, root));

	pi.registerTool({
		...localRead,
		async execute(id, params, signal, onUpdate, ctx) {
			const ssh = getSsh();
			if (ssh && !isLocalSkillPath(params.path)) {
				const tool = createReadToolDefinition(localCwd, {
					operations: createRemoteReadOps(ssh.remote, ssh.remoteCwd, localCwd),
				});
				return tool.execute(id, params, signal, onUpdate, ctx);
			}
			return localRead.execute(id, params, signal, onUpdate, ctx);
		},
	});

	pi.registerTool({
		...localWrite,
		async execute(id, params, signal, onUpdate, ctx) {
			const ssh = getSsh();
			if (ssh) {
				const tool = createWriteToolDefinition(localCwd, {
					operations: createRemoteWriteOps(ssh.remote, ssh.remoteCwd, localCwd),
				});
				return tool.execute(id, params, signal, onUpdate, ctx);
			}
			return localWrite.execute(id, params, signal, onUpdate, ctx);
		},
	});

	pi.registerTool({
		...localEdit,
		async execute(id, params, signal, onUpdate, ctx) {
			const ssh = getSsh();
			if (ssh) {
				const tool = createEditToolDefinition(localCwd, {
					operations: createRemoteEditOps(ssh.remote, ssh.remoteCwd, localCwd),
				});
				return tool.execute(id, params, signal, onUpdate, ctx);
			}
			return localEdit.execute(id, params, signal, onUpdate, ctx);
		},
	});

	pi.registerTool({
		...localBash,
		async execute(id, params, signal, onUpdate, ctx) {
			const ssh = getSsh();
			if (ssh && !isLocalSkillCommand(params.command)) {
				const tool = createBashToolDefinition(localCwd, {
					operations: createRemoteBashOps(ssh.remote, ssh.remoteCwd, localCwd),
				});
				return tool.execute(id, params, signal, onUpdate, ctx);
			}
			return localBash.execute(id, params, signal, onUpdate, ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		// Resolve SSH config now that CLI flags are available
		const arg = pi.getFlag("ssh") as string | undefined;
		if (arg) {
			if (arg.includes(":")) {
				const [remote, path] = arg.split(":");
				resolvedSsh = { remote, remoteCwd: path };
			} else {
				// No path given, evaluate pwd on remote
				const remote = arg;
				const pwd = (await sshExec(remote, "pwd")).toString().trim();
				resolvedSsh = { remote, remoteCwd: pwd };
			}
			pi.events.emit(SSH_STATE_EVENT, resolvedSsh);
			ctx.ui.setStatus("ssh", ctx.ui.theme.fg("accent", `SSH: ${resolvedSsh.remote}:${resolvedSsh.remoteCwd}`));
			ctx.ui.notify(`SSH mode: ${resolvedSsh.remote}:${resolvedSsh.remoteCwd}`, "info");
		} else {
			resolvedSsh = null;
			pi.events.emit(SSH_STATE_EVENT, null);
		}
	});

	// Handle user ! commands via SSH
	pi.on("user_bash", (_event) => {
		const ssh = getSsh();
		if (!ssh) return; // No SSH, use local execution
		return { operations: createRemoteBashOps(ssh.remote, ssh.remoteCwd, localCwd) };
	});

	// Keep loaded skills local even while the project tools target the SSH host.
	pi.on("before_agent_start", async (event) => {
		updateLocalSkills(event.systemPromptOptions.skills);

		const ssh = getSsh();
		if (ssh) {
			const modified = event.systemPrompt.replace(
				`Current working directory: ${localCwd}`,
				`Current working directory: ${ssh.remoteCwd} (via SSH: ${ssh.remote})`,
			);
			return { systemPrompt: modified };
		}
	});
}
