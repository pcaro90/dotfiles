import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, symlinkSync, existsSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { convertToLlm, createCodemodeExtension, discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import environment, { localSkillScript, withoutDocs } from "../index.js";
import { applyResource, canonicalPath, commandWords, decodeState, initialState, policyKey, restoreState, STATE_ENTRY, type EnvironmentState } from "../state.js";
import { backendCapture, bubbleBackend, directBackend, parseSshTarget, privateHome, probeBubble, remotePath, resolveSshTarget, sshBackend } from "../backends.js";
import { runProcess, shellQuote } from "../process.js";
import { registerEnvironmentTools, bashOperations } from "../tools.js";

// Outside /tmp: /tmp is intentionally shared and therefore is not a valid denial fixture.
const root = mkdtempSync(join(homedir(), ".cache/pi-environment-test-"));
const project = join(root, "project"), readonly = join(root, "readonly"), secret = join(root, "secret");
const session = `test-${randomUUID()}`;
let policy: EnvironmentState;
beforeAll(() => {
	for (const dir of [project, readonly, secret]) mkdirSync(dir);
	writeFileSync(join(readonly, "data"), "readonly\n");
	writeFileSync(join(secret, "hidden"), "secret\n");
	policy = initialState(project);
	policy.readPaths.push(readonly);
});
afterAll(() => {
	rmSync(root, { recursive: true, force: true });
	rmSync(dirname(privateHome(session)), { recursive: true, force: true });
});

function fakePi(flags: Record<string, any> = {}, entries: any[] = []) {
	const tools = new Map<string, any>(), commands = new Map<string, any>(), hooks = new Map<string, any[]>(), shortcuts = new Map<string, any>();
	const messages: any[] = [], notices: any[] = [], statuses: any[] = [];
	let active = ["read", "write", "edit", "bash", "grep", "find", "ls", "questionnaire", "codemode"];
	const pi: any = {
		registerFlag() {}, registerMessageRenderer() {}, getFlag: (name: string) => flags[name], registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		registerShortcut: (key: string, shortcut: any) => shortcuts.set(key, shortcut),
		on: (name: string, handler: any) => hooks.set(name, [...hooks.get(name) ?? [], handler]),
		appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data: structuredClone(data) }),
		sendMessage: (message: any, options: any) => messages.push({ message, options }),
		getActiveTools: () => active, setActiveTools: (names: string[]) => { active = names; },
		getAllTools: () => [...tools.values()].map((t) => ({ ...t })),
	};
	const ctx: any = {
		cwd: project, mode: "tui", hasUI: true, isIdle: () => true,
		sessionManager: { getSessionId: () => session, getSessionFile: () => undefined, getBranch: () => entries },
		ui: {
			theme: { fg: (_color: string, value: string) => value }, setStatus: (...args: any[]) => statuses.push(args),
			notify: (...args: any[]) => notices.push(args), select: async () => "Allow", confirm: async () => true,
			input: async () => undefined,
		},
	};
	const emit = async (name: string, event: any = {}) => {
		const results = [];
		for (const handler of hooks.get(name) ?? []) results.push(await handler(event, ctx));
		if (name === "before_agent_start") for (const result of results) if (result?.message) entries.push({ type: "custom_message", ...structuredClone(result.message) });
		return results;
	};
	const execute = async (name: string, input: any, signal?: AbortSignal) => {
		const blocked = (await emit("tool_call", { toolName: name, input })).find((r: any) => r?.block);
		if (blocked) throw new Error(blocked.reason);
		return tools.get(name).execute(randomUUID(), input, signal, undefined, ctx);
	};
	return { pi, ctx, tools, commands, shortcuts, emit, execute, entries, messages, notices, statuses, active: () => active };
}
async function loaded(flags: Record<string, any> = {}, saved = policy) {
	const harness = fakePi(flags, [{ type: "custom", customType: STATE_ENTRY, data: structuredClone(saved) }]);
	environment(harness.pi);
	await harness.emit("session_start", { reason: "startup" });
	return harness;
}
function text(result: any): string { return result.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n"); }

describe("state and argument handling", () => {
	test("default-deny, project and /tmp RW, no privileged sockets", () => {
		expect(policy.writePaths).toEqual([project, "/tmp"]);
		expect(policy.sshAgent).toBe(false); expect(policy.docker).toBe(false);
		expect(policy.readPaths).not.toContain(homedir());
	});
	test("state roundtrips, branches and invalid persisted data", () => {
		expect(decodeState(JSON.parse(JSON.stringify(policy)))).toEqual(policy);
		expect(restoreState([{ type: "custom", customType: STATE_ENTRY, data: policy }])).toEqual(policy);
		expect(restoreState([])).toBeUndefined();
		expect(() => decodeState({ ...policy, mode: "oops" })).toThrow("Invalid Environment");
		expect(() => decodeState({ ...policy, writePaths: ["relative"] })).toThrow("Invalid Environment");
	});
	test("policy equality ignores ordering/provenance and dormant SSH settings, not actual access", () => {
		expect(policyKey({ ...policy, readPaths: [...policy.readPaths].reverse(), writePaths: [...policy.writePaths].reverse(), profileReadPaths: [], readGrants: [readonly], sshSkills: ["other"], remote: { host: "unused", cwd: "/", home: "/" } })).toBe(policyKey(policy));
		expect(policyKey({ ...policy, readPaths: [...policy.readPaths.slice(0, -1), secret] })).not.toBe(policyKey(policy));
		expect(policyKey({ ...policy, pathAliases: { "/alias": readonly } })).not.toBe(policyKey(policy));
		expect(policyKey({ ...policy, sshAgent: true })).not.toBe(policyKey(policy));
	});
	test("RO/RW changes do not mutate previous execution policies", () => {
		const changed = applyResource(policy, { type: "path", path: readonly, access: "rw" });
		expect(changed.writePaths).toContain(readonly); expect(changed.readPaths).not.toContain(readonly);
		expect(policy.readPaths).toContain(readonly); expect(policy.writePaths).not.toContain(readonly);
		expect(applyResource(changed, { type: "path", path: readonly, access: "rw" }, false).writePaths).not.toContain(readonly);
	});
	test("removed resources can still be revoked", () => {
		const missing = join(root, "removed");
		const restored = { ...policy, readPaths: [...policy.readPaths, missing] };
		expect(applyResource(restored, { type: "path", path: missing, access: "ro" }, false).readPaths).not.toContain(missing);
	});
	test("command quoting and SSH destinations do not introduce shell expansion", () => {
		expect(commandWords(`allow rw '/a path'`)).toEqual(["allow", "rw", "/a path"]);
		expect(() => commandWords("'broken")).toThrow("Unclosed");
		expect(parseSshTarget("user@[::1]:/a:b")).toEqual({ host: "user@[::1]", path: "/a:b" });
		expect(() => parseSshTarget("-oProxyCommand=bad")).toThrow();
		expect(remotePath("~/x", { host: "h", cwd: "/work", home: "/root" })).toBe("/root/x");
	});
	test("docs filter only removes the docs section and preserves local instructions", () => {
		const messages = [{ role: "system", content: "", sections: { docs: "local docs", cwd: "/remote", project_context: "local AGENTS.md", preamble: "keep" } }, { role: "user", content: "hello" }];
		const filtered = withoutDocs(messages);
		expect(filtered[0].sections?.docs).toBeUndefined(); expect(filtered[0].sections?.project_context).toBe("local AGENTS.md");
		expect(messages[0].sections?.docs).toBe("local docs"); expect(filtered[1]).toBe(messages[1]);
	});
});

describe("bubble skill discovery and aliases", () => {
	test("all advertised skill paths stay readable outside the workspace, independent of SSH skill selection", async () => {
		const dir = mkdtempSync(join(root, "skill-alias-")), bin = join(dir, "bin"), registry = join(dir, "registry"), source = join(project, "scripted-source"), plain = join(registry, "plain"), alias = join(registry, "linked");
		const fileRoot = join(registry, "file-linked"), fileTarget = join(dir, "external-SKILL.md");
		for (const path of [bin, plain, fileRoot, join(source, "scripts"), join(source, "references")]) mkdirSync(path, { recursive: true });
		writeFileSync(join(plain, "SKILL.md"), "plain docs"); writeFileSync(join(source, "SKILL.md"), "linked docs");
		writeFileSync(join(source, "references/info"), "linked reference"); writeFileSync(join(source, "scripts/run.sh"), "printf linked-script"); symlinkSync(source, alias);
		writeFileSync(fileTarget, "file-linked docs"); symlinkSync(fileTarget, join(fileRoot, "SKILL.md"));
		const paths = [join(plain, "SKILL.md"), join(alias, "SKILL.md"), join(alias, "references/info"), join(alias, "scripts/run.sh"), join(fileRoot, "SKILL.md")];
		// Model longest-prefix binds/private home and the absolute file symlink in this fixture.
		// This launcher is not a kernel-boundary test; the real bwrap case is tested below.
		const launcher = `#!/usr/bin/env python3\nimport os, sys\nargs = sys.argv[1:]\nmounts = []\ni = 0\nwhile i < len(args) and args[i] != '--':\n    if args[i] in ('--bind', '--ro-bind'):\n        mounts.append((args[i+2], os.path.realpath(args[i+1])))\n        i += 3\n    else:\n        i += 1\ndef project(path):\n    matches = [(target, source) for target, source in mounts if path == target or path.startswith(target + '/')]\n    target, source = max(matches, key=lambda item: len(item[0]))\n    relative = os.path.relpath(path, target)\n    return source if relative == '.' else os.path.join(source, relative)\ncommand = args[-1]\nfor path in ${JSON.stringify(paths)}:\n    physical = project(path)\n    if os.path.islink(physical):\n        link = os.readlink(physical)\n        assert os.path.isabs(link)\n        physical = project(link)\n    command = command.replace(path, physical)\nos.execv('/bin/bash', ['bash', '--noprofile', '--norc', '-c', command])\n`;
		writeFileSync(join(bin, "bwrap"), launcher); chmodSync(join(bin, "bwrap"), 0o700);
		const previous = process.env.PATH; process.env.PATH = `${bin}:${previous}`;
		try {
			const h = await loaded({}, { ...policy, sshSkills: ["plain"] });
			const options: any = { skills: [{ name: "plain", baseDir: plain, filePath: paths[0] }, { name: "scripted", baseDir: alias, filePath: paths[1] }, { name: "file-linked", baseDir: fileRoot, filePath: paths[4] }] };
			await h.emit("before_agent_start", { systemPromptOptions: options });
			expect(options.skills).toHaveLength(3);
			for (const [i, expected] of ["plain docs", "linked docs", "linked reference", "printf linked-script", "file-linked docs"].entries()) {
				const result = await h.execute("read", { path: paths[i] });
				expect(result.structuredContent).toBe(expected);
			}
			expect(restoreState(h.entries)!.sshSkills).toEqual(["plain"]);
			await h.commands.get("env").handler(`allow rw ${shellQuote(alias)}`, h.ctx);
			await h.execute("edit", { path: paths[1], edits: [{ oldText: "linked docs", newText: "edited docs" }] });
			expect(readFileSync(join(source, "SKILL.md"), "utf8")).toBe("edited docs");
		} finally { process.env.PATH = previous; }
	});
});

describe("keyboard shortcuts", () => {
	// This fixture stubs ONLY the bwrap validation launcher. It tests actual socket
	// checks, policy updates, persistence and key handlers, not the kernel boundary.
	async function fixture(run: (h: Awaited<ReturnType<typeof loaded>>, press: (key: string) => Promise<void>, files: { agent: string; docker: string; gate: string; started: string }) => Promise<void>) {
		const dir = mkdtempSync(join(root, "keyboard-")), bin = join(dir, "bin"); mkdirSync(bin);
		const files = { agent: join(dir, "agent.sock"), docker: join(dir, "docker.sock"), gate: join(dir, "gate"), started: join(dir, "started") };
		writeFileSync(join(bin, "bwrap"), `#!/bin/bash\nif test -e ${shellQuote(files.gate)}; then : > ${shellQuote(files.started)}; while test -e ${shellQuote(files.gate)}; do sleep 0.01; done; fi\nexit 0\n`); chmodSync(join(bin, "bwrap"), 0o700);
		const previous = { PATH: process.env.PATH, SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK, DOCKER_HOST: process.env.DOCKER_HOST };
		const servers = [createServer(), createServer()], pending = new Set<Promise<void>>();
		try {
			for (const [i, path] of [files.agent, files.docker].entries()) await new Promise<void>((resolve, reject) => { servers[i].once("error", reject); servers[i].listen(path, resolve); });
			process.env.PATH = `${bin}:${previous.PATH}`; process.env.SSH_AUTH_SOCK = files.agent; process.env.DOCKER_HOST = `unix://${files.docker}`;
			const h = await loaded(); expect(h.notices).toEqual([]);
			const press = (key: string): Promise<void> => {
				const operation = Promise.resolve(h.shortcuts.get(key).handler(h.ctx)); pending.add(operation);
				void operation.finally(() => pending.delete(operation)); return operation;
			};
			await run(h, press, files);
		} finally {
			rmSync(files.gate, { force: true }); await Promise.allSettled([...pending]);
			for (const server of servers) if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
			for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
		}
	}
	test("native bindings recognize CSI-u/Kitty and modifyOtherKeys, never plain digits, Tab or Ctrl+Space", () => {
		const h = fakePi(); environment(h.pi);
		expect([...h.shortcuts.keys()]).toEqual(["ctrl+1", "ctrl+2", "ctrl+tab"]);
		for (const [key, code] of [["ctrl+1", 49], ["ctrl+2", 50], ["ctrl+tab", 9]] as const) {
			expect(matchesKey(`\x1b[${code};5u`, key)).toBe(true);
			expect(matchesKey(`\x1b[27;5;${code}~`, key)).toBe(true);
			for (const ordinary of ["1", "2", "\t", "\0", "\x1b[32;5u"]) expect(matchesKey(ordinary, key)).toBe(false);
		}
	});
	test("Ctrl+1/Ctrl+2 toggle independently, update footer immediately and survive reload", async () => {
		await fixture(async (h, press) => {
			await press("ctrl+1"); expect(restoreState(h.entries)!.sshAgent).toBe(true); expect(restoreState(h.entries)!.docker).toBe(false); expect(h.statuses.at(-1)[1]).toBe("🫧 🔑");
			await press("ctrl+2"); expect(restoreState(h.entries)!.docker).toBe(true); expect(h.statuses.at(-1)[1]).toBe("🫧 🔑 🐳");
			await h.emit("session_start", { reason: "reload" }); expect(h.statuses.at(-1)[1]).toBe("🫧 🔑 🐳");
			await press("ctrl+1"); expect(restoreState(h.entries)!.sshAgent).toBe(false); expect(h.statuses.at(-1)[1]).toBe("🫧 🐳");
			await press("ctrl+2"); expect(restoreState(h.entries)!.docker).toBe(false); expect(h.statuses.at(-1)[1]).toBe("🫧");
			expect(h.messages).toHaveLength(0);
		});
	});
	test("failed enables are atomic, do not poison the queue, and stale sockets can be revoked", async () => {
		await fixture(async (h, press, files) => {
			const before = restoreState(h.entries);
			process.env.SSH_AUTH_SOCK = files.agent + ".missing"; await press("ctrl+1");
			expect(restoreState(h.entries)).toEqual(before); expect(h.messages).toHaveLength(0); expect(h.notices.at(-1)[1]).toBe("error");
			process.env.SSH_AUTH_SOCK = files.agent; await press("ctrl+1"); expect(restoreState(h.entries)!.sshAgent).toBe(true);
			process.env.DOCKER_HOST = `unix://${files.docker}.missing`; await press("ctrl+2"); expect(restoreState(h.entries)!.docker).toBe(false); expect(h.messages).toHaveLength(0);
			process.env.SSH_AUTH_SOCK = files.agent + ".missing"; await press("ctrl+1"); expect(restoreState(h.entries)!.sshAgent).toBe(false); expect(h.statuses.at(-1)[1]).toBe("🫧");
		});
	});
	test("rapid repeated/mixed presses are serialized instead of losing toggles", async () => {
		await fixture(async (h, press) => {
			await Promise.all([press("ctrl+1"), press("ctrl+2"), press("ctrl+1"), press("ctrl+2")]);
			expect(restoreState(h.entries)!.sshAgent).toBe(false); expect(restoreState(h.entries)!.docker).toBe(false); expect(h.messages).toHaveLength(0);
			expect(h.notices).toEqual([]);
		});
	});
	test("permission notices coalesce net changes at the next input, including across reload", async () => {
		await fixture(async (h, press) => {
			const input = () => h.emit("before_agent_start", { systemPromptOptions: { skills: [] } });
			const [initial] = await input(); expect(initial.message.display).toBe(false);
			expect(convertToLlm([{ ...initial.message, role: "custom", timestamp: 0 }])).toEqual([{ role: "user", content: [{ type: "text", text: initial.message.content }], timestamp: 0 }]);
			const prefix = JSON.stringify(h.entries), length = h.entries.length;
			await press("ctrl+2"); await press("ctrl+2");
			expect((await input())[0]).toBeUndefined(); expect(h.messages).toHaveLength(0);
			expect(JSON.stringify(h.entries.slice(0, length))).toBe(prefix); // Never rewrite cached history.
			await press("ctrl+1"); await press("ctrl+2");
			const [changed] = await input(); expect(changed.message.display).toBe(true);
			expect(changed.message.content).toContain("SSH agent on; Docker on");
			expect((await input())[0]).toBeUndefined();
			await h.emit("session_start", { reason: "reload" }); expect((await input())[0]).toBeUndefined();
			await press("ctrl+2"); await h.emit("session_start", { reason: "reload" }); await press("ctrl+2");
			expect((await input())[0]).toBeUndefined();
			expect(h.entries.filter((e) => e.type === "custom_message")).toHaveLength(2);
		});
	});
	test("request_access communicates the current policy once in its result, including concurrent toggles", async () => {
		await fixture(async (h, press) => {
			const input = () => h.emit("before_agent_start", { systemPromptOptions: { skills: [] } });
			await input(); h.ctx.isIdle = () => false;
			h.ctx.ui.select = async () => { await press("ctrl+2"); return "Allow"; };
			const result = await h.execute("request_access", { resources: [{ type: "path", path: readonly, access: "rw" }], reason: "Write fixture" });
			expect(result.details.granted).toBe(true); expect(text(result)).toContain("Docker on"); expect(text(result)).toContain(`RW ${readonly}`);
			expect(result.details.policy).toBe(policyKey(restoreState(h.entries)!)); expect(h.messages).toHaveLength(0);
			h.entries.push({ type: "message", message: { role: "toolResult", toolName: "request_access", ...result } });
			h.ctx.isIdle = () => true; await h.emit("session_start", { reason: "reload" });
			expect((await input())[0]).toBeUndefined(); // The tool result already informed the model.
			await press("ctrl+2"); await h.commands.get("env").handler(`allow ro ${shellQuote(readonly)}`, h.ctx);
			const [revoked] = await input(); expect(revoked.message.display).toBe(true); expect(revoked.message.content).toContain("Docker off");
			expect((await input())[0]).toBeUndefined();
		});
	});
	test("announcement baselines follow the active branch and reset after compaction", async () => {
		await fixture(async (h, press) => {
			const input = () => h.emit("before_agent_start", { systemPromptOptions: { skills: [] } });
			await input(); const fork = h.entries.length;
			await press("ctrl+1"); expect((await input())[0].message.display).toBe(true);
			h.entries.splice(fork); await h.emit("session_tree"); expect((await input())[0]).toBeUndefined();
			h.entries.push({ type: "compaction" }); await h.emit("session_compact"); await h.emit("session_start", { reason: "reload" });
			expect((await input())[0].message.display).toBe(false); expect((await input())[0]).toBeUndefined();
		});
	});
	test("Ctrl+Tab toggles local modes without resetting grants; busy mode changes are rejected", async () => {
		await fixture(async (h, press) => {
			await press("ctrl+1"); await press("ctrl+2"); await press("ctrl+tab");
			expect(restoreState(h.entries)!.mode).toBe("direct"); expect(h.statuses.at(-1)[1]).toBe("💻");
			const direct = restoreState(h.entries), count = h.messages.length;
			await press("ctrl+1"); await press("ctrl+2"); expect(restoreState(h.entries)).toEqual(direct); expect(h.messages).toHaveLength(count);
			await press("ctrl+tab"); expect(restoreState(h.entries)!.mode).toBe("bubble"); expect(h.statuses.at(-1)[1]).toBe("🫧 🔑 🐳");
			h.ctx.isIdle = () => false;
			await press("ctrl+tab"); expect(restoreState(h.entries)!.mode).toBe("bubble"); expect(h.notices.at(-1)[0]).toContain("stop");
			const snapshot = restoreState(h.entries)!; await press("ctrl+1"); // Capability changes are allowed while busy, for future calls.
			expect(snapshot.sshAgent).toBe(true); expect(restoreState(h.entries)!.sshAgent).toBe(false);
		});
	});
	test("shortcuts never leave SSH or unblock failed initialization", async () => {
		const remote: EnvironmentState = { ...policy, mode: "ssh", remote: { host: "not-contacted.invalid", cwd: "/root", home: "/root" } };
		const h = await loaded({}, remote), count = h.entries.length;
		for (const key of ["ctrl+1", "ctrl+2", "ctrl+tab"]) await h.shortcuts.get(key).handler(h.ctx);
		expect(h.entries).toHaveLength(count); expect(restoreState(h.entries)!.mode).toBe("ssh"); expect(h.messages).toHaveLength(0);
		const blocked = await loaded({ direct: true, ssh: "host" }), entries = blocked.entries.length;
		for (const key of ["ctrl+1", "ctrl+2", "ctrl+tab"]) await blocked.shortcuts.get(key).handler(blocked.ctx);
		expect(blocked.entries).toHaveLength(entries); expect(blocked.messages).toHaveLength(0); expect(blocked.notices.at(-1)[0]).toContain("mutually exclusive");
	});
	test("in-flight/queued shortcut grants are discarded after shutdown", async () => {
		await fixture(async (h, press, files) => {
			const count = h.entries.length; writeFileSync(files.gate, "wait");
			const first = press("ctrl+1"), second = press("ctrl+2");
			for (let i = 0; i < 100 && !existsSync(files.started); i++) await Bun.sleep(5);
			expect(existsSync(files.started)).toBe(true); await h.emit("session_shutdown"); rmSync(files.gate);
			await Promise.all([first, second]); expect(h.entries).toHaveLength(count); expect(h.messages).toHaveLength(0);
		});
	});
});

describe("actual Bubblewrap boundary", () => {
	test("toolchain works, home is private, host secrets are not exposed", async () => {
		const b = bubbleBackend(policy, session);
		const result = await b.run(`node --version; python3 --version; test ! -e ${shellQuote(join(secret, "hidden"))}; test ! -e /etc/shadow`);
		expect(result.exitCode).toBe(0); expect(result.stdout.toString()).toContain("Python");
		expect(() => b.assertAccess!(join(secret, "hidden"), true)).not.toThrow(); // The home path is private, not the host home.
		await expect(backendCapture(b, `cat ${shellQuote(join(secret, "hidden"))}`)).rejects.toThrow("current bubble");
	});
	test("workspace RW, external directory RO; direct mode is unrestricted", async () => {
		const b = bubbleBackend(policy, session);
		expect((await b.run(`printf ok > ${shellQuote(join(project, "written"))}`)).exitCode).toBe(0);
		expect(readFileSync(join(project, "written"), "utf8")).toBe("ok");
		expect((await b.run(`printf bad > ${shellQuote(join(readonly, "blocked"))}`)).exitCode).not.toBe(0);
		expect(existsSync(join(readonly, "blocked"))).toBe(false);
		expect((await directBackend(project).run(`printf direct > ${shellQuote(join(readonly, "direct"))}`)).exitCode).toBe(0);
	});
	test("symlinks in the project cannot reveal an unexposed host path", async () => {
		const link = join(project, "escape"); symlinkSync(secret, link);
		const result = await bubbleBackend(policy, session).run(`cat ${shellQuote(join(link, "hidden"))}`);
		expect(result.exitCode).not.toBe(0); expect(result.stdout.toString()).not.toContain("secret");
	});
	test("a granted symlink file is readable at its original name in the private home", async () => {
		const alias = join(root, "external-config-link"), target = join(secret, "hidden");
		symlinkSync(target, alias);
		const granted = applyResource(policy, { type: "path", path: alias, access: "ro" });
		const b = bubbleBackend(granted, session);
		expect(() => b.assertAccess!(alias, false)).not.toThrow();
		expect((await backendCapture(b, `cat -- ${shellQuote(alias)}`)).toString()).toBe("secret\n");
	});
	test("symlinked skills remain readable by advertised names with a private home, and remain RO", async () => {
		const target = join(project, "real-skill"), registry = join(root, "registry"), alias = join(registry, "linked-skill");
		mkdirSync(target); mkdirSync(registry); writeFileSync(join(target, "SKILL.md"), "linked skill"); symlinkSync(target, alias);
		const b = bubbleBackend(policy, session, [alias]);
		expect((await backendCapture(b, `cat -- ${shellQuote(join(alias, "SKILL.md"))}`)).toString()).toBe("linked skill");
		expect((await b.run(`printf denied > ${shellQuote(join(alias, "new-file"))}`)).exitCode).not.toBe(0);
		expect(existsSync(join(target, "new-file"))).toBe(false);
	});
	test("skills whose registry is the workspace follow their original symlink to the RO target", async () => {
		const target = join(root, "external-skill-target"), alias = join(project, "external-skill-link");
		mkdirSync(target); writeFileSync(join(target, "SKILL.md"), "external skill"); symlinkSync(target, alias);
		const b = bubbleBackend(policy, session, [alias]);
		expect((await backendCapture(b, `cat -- ${shellQuote(join(alias, "SKILL.md"))}`)).toString()).toBe("external skill");
		expect((await b.run(`printf denied > ${shellQuote(join(alias, "new-file"))}`)).exitCode).not.toBe(0);
	});
	test("an independently linked instruction file is available without exposing its parent", async () => {
		const base = join(root, "file-linked-skill"), target = join(root, "external-instructions.md"), alias = join(base, "SKILL.md");
		mkdirSync(base); writeFileSync(target, "file-linked skill"); symlinkSync(target, alias);
		const b = bubbleBackend(policy, session, [base, alias]);
		expect((await backendCapture(b, `cat -- ${shellQuote(alias)}`)).toString()).toBe("file-linked skill");
	});
	test("new grants and revocations do not mutate an already-created backend", async () => {
		const before = bubbleBackend(policy, session);
		const granted = applyResource(policy, { type: "path", path: readonly, access: "rw" });
		const after = bubbleBackend(granted, session);
		expect((await after.run(`printf yes > ${shellQuote(join(readonly, "granted"))}`)).exitCode).toBe(0);
		expect((await before.run(`printf no > ${shellQuote(join(readonly, "old-policy"))}`)).exitCode).not.toBe(0);
		const revoked = applyResource(granted, { type: "path", path: readonly, access: "rw" }, false);
		expect((await bubbleBackend(revoked, session).run(`test ! -e ${shellQuote(join(readonly, "data"))}`)).exitCode).toBe(0);
	});
	test("shared /tmp and clean child environment", async () => {
		const temp = `/tmp/pi-environment-shared-${randomUUID()}`;
		process.env.ENVIRONMENT_TEST_SECRET = "do-not-inherit";
		try {
			const result = await bubbleBackend(policy, session).run(`printf shared > ${shellQuote(temp)}; test -z "$ENVIRONMENT_TEST_SECRET"; test -z "$SSH_AUTH_SOCK"; test -z "$DOCKER_HOST"`);
			expect(result.exitCode).toBe(0); expect(readFileSync(temp, "utf8")).toBe("shared");
		} finally { delete process.env.ENVIRONMENT_TEST_SECRET; rmSync(temp, { force: true }); }
	});
	test("sandbox initialization errors never execute on the host", async () => {
		await expect(bubbleBackend(policy, session, [], "/missing/bwrap").run("touch /tmp/never-run")).rejects.toThrow();
		await expect(probeBubble({ ...policy, readPaths: [...policy.readPaths, "/missing/resource"] }, session)).rejects.toThrow("unavailable");
	});
	test("personal SSH agent and Docker are exposed only when granted, even below shared /tmp", async () => {
		const socket = `/tmp/pi-environment-socket-${randomUUID()}`;
		const server = createServer((connection) => connection.end());
		await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
		const oldAgent = process.env.SSH_AUTH_SOCK, oldDocker = process.env.DOCKER_HOST;
		process.env.SSH_AUTH_SOCK = socket; process.env.DOCKER_HOST = `unix://${socket}`;
		const connect = `python3 -c ${shellQuote(`import socket; s=socket.socket(socket.AF_UNIX); s.connect(${JSON.stringify(socket)}); print('connected')`)}`;
		try {
			expect((await bubbleBackend(policy, session).run(connect)).exitCode).not.toBe(0);
			// Both capabilities point to the same test socket, so both must be enabled to unmask it.
			const allowed = { ...policy, sshAgent: true, docker: true };
			expect((await bubbleBackend(allowed, session).run(connect)).stdout.toString()).toContain("connected");
			expect((await bubbleBackend(policy, session).run(connect)).exitCode).not.toBe(0);
		} finally {
			if (oldAgent === undefined) delete process.env.SSH_AUTH_SOCK; else process.env.SSH_AUTH_SOCK = oldAgent;
			if (oldDocker === undefined) delete process.env.DOCKER_HOST; else process.env.DOCKER_HOST = oldDocker;
			await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(socket, { force: true });
		}
	});
	test("socket grants canonicalize symlinked parents instead of mounting through a dangling namespace alias", async () => {
		const socket = join(root, "canonical-docker.sock"), alias = `/tmp/pi-environment-alias-${randomUUID()}`;
		symlinkSync(root, alias);
		const server = createServer();
		await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
		const previous = process.env.DOCKER_HOST; process.env.DOCKER_HOST = `unix://${alias}/canonical-docker.sock`;
		try {
			const result = await bubbleBackend({ ...policy, docker: true }, session).run('test -S "${DOCKER_HOST#unix://}" && printf "%s" "$DOCKER_HOST"');
			expect(result.exitCode).toBe(0); expect(result.stdout.toString()).toBe(`unix://${socket}`);
		} finally {
			if (previous === undefined) delete process.env.DOCKER_HOST; else process.env.DOCKER_HOST = previous;
			await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(alias, { force: true });
		}
	});
	test("short-lived shells do not leave background processes holding their pipes", async () => {
		expect((await bubbleBackend(policy, session).run("sleep 30 & printf done", { timeout: 2 })).stdout.toString()).toBe("done");
	});
	test("system aliases and dereferenced file mounts remain readable", async () => {
		const b = bubbleBackend(policy, session);
		expect(() => b.assertAccess!("/bin/bash", false)).not.toThrow();
		if (existsSync("/etc/localtime")) expect(() => b.assertAccess!("/etc/localtime", false)).not.toThrow();
	});
	test("timeout and pre-aborted cancellation", async () => {
		await expect(bubbleBackend(policy, session).run("sleep 10", { timeout: 0.05 })).rejects.toThrow("timeout:");
		const controller = new AbortController(); controller.abort();
		await expect(bubbleBackend(policy, session).run("true", { signal: controller.signal })).rejects.toThrow("aborted");
	});
	test("cancellation does not wait for a detached descendant holding the output", async () => {
		const controller = new AbortController(), start = performance.now();
		setTimeout(() => controller.abort(), 100);
		await expect(runProcess("/bin/bash", ["-c", "setsid sleep 5 & sleep 5"], { signal: controller.signal })).rejects.toThrow("aborted");
		await expect(runProcess("/bin/bash", ["-c", "setsid sleep 5 & sleep 5"], { timeout: 0.1 })).rejects.toThrow("timeout:");
		expect(performance.now() - start).toBeLessThan(2000);
	});
});

describe("four real Pi tool definitions", () => {
	test("write/read/edit stay inside the selected backend and preserve exact-edit semantics", async () => {
		const tools = new Map<string, any>(); const b = bubbleBackend(policy, session);
		registerEnvironmentTools({ registerTool: (t: any) => tools.set(t.name, t) } as any, {
			localRoot: () => project, backend: () => b, file: (path) => ({ backend: b, path: join(project, path) }), bash: () => b, track: (run) => run(),
		});
		const execute = (name: string, args: any) => tools.get(name).execute("test", args, undefined, undefined, undefined);
		await execute("write", { path: "sub/file", content: "one\ntwo\nthree\n" });
		expect(text(await execute("read", { path: "sub/file" }))).toContain("two");
		const edited = await execute("edit", { path: "sub/file", edits: [{ oldText: "one", newText: "ONE" }, { oldText: "three", newText: "THREE" }] });
		expect(edited.details.patch).not.toContain("pi-environment-mutations");
		expect(readFileSync(join(project, "sub/file"), "utf8")).toBe("ONE\ntwo\nTHREE\n");
		await expect(execute("edit", { path: "sub/file", edits: [{ oldText: "missing", newText: "x" }] })).rejects.toThrow();
	});
	test("tool file mutations cannot bypass a read-only mount", async () => {
		const h = await loaded();
		await expect(h.execute("write", { path: join(readonly, "tool-denied"), content: "no" })).rejects.toThrow("Blocked by the current bubble");
		await expect(h.execute("edit", { path: join(readonly, "data"), edits: [{ oldText: "readonly", newText: "changed" }] })).rejects.toThrow("Blocked by the current bubble");
	});
	test("bash error gives permission guidance and retains structured output", async () => {
		const h = await loaded();
		const result = await h.execute("bash", { command: `printf bad > ${shellQuote(join(readonly, "bash-denied"))}` });
		expect(result.structuredContent.exit_code).not.toBe(0);
		expect(result.structuredContent.output).toContain("request_access");
	});
});

describe("extension lifecycle and UX", () => {
	test("default bubble, four tools plus codemode/request_access; no find/grep/ls", async () => {
		const h = await loaded();
		expect(h.active()).toContain("codemode"); expect(h.active()).toContain("request_access");
		for (const name of ["find", "grep", "ls"]) expect(h.active()).not.toContain(name);
		expect(h.tools.get("bash").parameters.properties.target).toBeUndefined();
		const options: any = { cwd: project, skills: [], contextFiles: [{ path: "AGENTS.md", content: "local instructions" }] };
		const result = await h.emit("before_agent_start", { systemPromptOptions: options });
		expect(result[0].systemPrompt).toBeUndefined(); expect(result[0].message.content).toContain("BUBBLE");
		expect(options.contextFiles[0].content).toBe("local instructions");
	});
	test("automatic announcements remain model context, without extra visible history rows", async () => {
		const h = await loaded({ direct: true });
		const [announcement] = await h.emit("before_agent_start", { systemPromptOptions: { skills: [] } });
		expect(announcement.message.display).toBe(false); expect(announcement.message.content).toContain("DIRECT");
		await h.emit("session_start", { reason: "reload" });
		const [afterReload] = await h.emit("before_agent_start", { systemPromptOptions: { skills: [] } });
		expect(afterReload).toBeUndefined();
		const blocked = await loaded({ direct: true, ssh: "host" });
		const [error] = await blocked.emit("before_agent_start", { systemPromptOptions: { skills: [] } });
		expect(error.message.display).toBe(true); expect(error.message.content).toContain("mutually exclusive");
	});
	test("an unchanged profile refresh does not append duplicate state/messages", async () => {
		const h = await loaded({ direct: true });
		await h.commands.get("env").handler("refresh", h.ctx); // Materialize fixture grant provenance first.
		const entries = h.entries.length, messages = h.messages.length;
		await h.commands.get("env").handler("refresh", h.ctx);
		expect(h.entries).toHaveLength(entries); expect(h.messages).toHaveLength(messages);
		expect(h.notices.at(-1)[0]).toContain("already up to date");
	});
	test("CLI direct wins on startup, but reload restores changed state", async () => {
		const h = await loaded({ direct: true });
		expect(restoreState(h.entries)!.mode).toBe("direct");
		await h.commands.get("env").handler("bubble", h.ctx);
		expect(restoreState(h.entries)!.mode).toBe("bubble");
		await h.emit("session_start", { reason: "reload" });
		expect(restoreState(h.entries)!.mode).toBe("bubble");
		expect(h.messages).toHaveLength(0);
	});
	test("conflicting CLI flags fail closed, including user ! commands", async () => {
		const h = await loaded({ direct: true, ssh: "host" });
		await expect(h.execute("bash", { command: "true" })).rejects.toThrow("mutually exclusive");
		await expect(h.emit("user_bash", { command: "true" })).rejects.toThrow("mutually exclusive");
	});
	test("changing modes while busy is rejected", async () => {
		const h = await loaded(); h.ctx.isIdle = () => false;
		await h.commands.get("env").handler("direct", h.ctx);
		expect(restoreState(h.entries)!.mode).toBe("bubble"); expect(h.notices.at(-1)[0]).toContain("stop");
	});
	test("request_access is model-only, grant/denial/no-UI and JSONL persistence", async () => {
		const h = await loaded(); expect(h.tools.get("request_access").exposure).toBe("model-only");
		const result = await h.execute("request_access", { resources: [{ type: "path", path: readonly, access: "rw" }], reason: "Store results" });
		expect(result.details.granted).toBe(true); expect(restoreState(h.entries)!.writePaths).toContain(readonly);
		h.ctx.ui.select = async () => "Deny";
		expect((await h.execute("request_access", { resources: [{ type: "path", path: secret, access: "ro" }], reason: "Read fixture" })).details.granted).toBe(false);
		expect(restoreState(h.entries)!.readPaths).not.toContain(secret);
		h.ctx.hasUI = false;
		await expect(h.execute("request_access", { resources: [{ type: "path", path: secret, access: "ro" }], reason: "No UI" })).rejects.toThrow("no approval UI");
	});
	test("tree navigation restores policy from the active branch", async () => {
		const h = await loaded(); const entryCount = h.entries.length;
		await h.commands.get("env").handler("direct", h.ctx);
		expect(restoreState(h.entries)!.mode).toBe("direct");
		h.entries.splice(entryCount); await h.emit("session_tree");
		const r = await h.emit("before_agent_start", { systemPromptOptions: { skills: [] } });
		expect(r[0].message.content).toContain("BUBBLE");
	});
	test("a stale mount blocks startup but can be removed from /env without resetting everything", async () => {
		const missing = join(root, "stale-mount");
		const h = await loaded({}, { ...policy, readPaths: [...policy.readPaths, missing] });
		await expect(h.execute("bash", { command: "true" })).rejects.toThrow("initialization failed");
		await h.commands.get("env").handler(`revoke ro ${shellQuote(missing)}`, h.ctx);
		expect(restoreState(h.entries)!.readPaths).not.toContain(missing);
		expect((await h.execute("bash", { command: "true" })).structuredContent.exit_code).toBe(0);
	});
	test("real codemode calls go through the same routed tools and permission hooks", async () => {
		const h = await loaded();
		createCodemodeExtension({ models: false })(h.pi);
		h.ctx.tools = [...h.tools.values()].filter((tool) => tool.exposure !== "model-only");
		h.ctx.executeTool = async (name: string, args: any, options: any) => {
			const toolCall = { type: "toolCall", id: `codemode/${randomUUID()}`, name, arguments: args };
			try { return { toolCall, result: await h.execute(name, args, options.signal), isError: false }; }
			catch (error) { return { toolCall, result: { content: [{ type: "text", text: String(error) }] }, isError: true }; }
		};
		const file = join(project, "codemode-created");
		const code = `await tools.write({path:${JSON.stringify(file)},content:'from codemode'}); text(await tools.read({path:${JSON.stringify(file)}})); const denied=await Promise.allSettled([tools.write({path:${JSON.stringify(join(readonly, "codemode-denied"))},content:'no'})]); text(denied[0].status);`;
		const result = await h.execute("codemode", { code });
		expect(text(result)).toContain("from codemode"); expect(text(result)).toContain("rejected");
		expect(existsSync(join(readonly, "codemode-denied"))).toBe(false);
	}, 30000);
	test("MCP authorization applies to nested calls, not only directly active tools", async () => {
		const h = await loaded();
		h.pi.getAllTools = () => [{ name: "mcp__docs__search", namespace: { name: "mcp__docs" }, exposure: "deferred" }];
		expect((await h.emit("tool_call", { toolName: "mcp__docs__search", input: {}, parentToolCallId: "codemode/1" }))[0].block).toBe(true);
		await h.commands.get("env").handler("allow mcp docs", h.ctx);
		expect((await h.emit("tool_call", { toolName: "mcp__docs__search", input: {}, parentToolCallId: "codemode/2" }))[0]).toBeUndefined();
	});
});

describe("SSH transport without a live remote", () => {
	const fakeSsh = join(root, "ssh-fixture");
	beforeAll(() => {
		// Execute precisely the remote shell string that OpenSSH would hand to the user's shell.
		writeFileSync(fakeSsh, '#!/bin/bash\nexec /bin/bash -c "${@: -1}"\n'); chmodSync(fakeSsh, 0o700);
	});
	test("resolve and file operations handle spaces, dollars, quotes and substitutions literally", async () => {
		const destination = join(project, "remote $HOME 'quoted' $(false)"); mkdirSync(destination);
		const remote = await resolveSshTarget(`test@fixture:${destination}`, fakeSsh);
		expect(remote.cwd).toBe(destination);
		const b = sshBackend(remote, fakeSsh);
		const name = join(destination, "file $HOME 'quoted' $(false)");
		await backendCapture(b, `cat > ${shellQuote(name)}`, { input: "remote data" });
		expect((await backendCapture(b, `cat -- ${shellQuote(name)}`)).toString()).toBe("remote data");
	});
	test("--ssh startup preserves the CLI contract and routes all four tools remotely", async () => {
		const link = join(root, "ssh"); symlinkSync(fakeSsh, link);
		const previousPath = process.env.PATH; process.env.PATH = `${root}:${previousPath}`;
		try {
			const h = fakePi({ ssh: `fixture:${project}` }); environment(h.pi);
			await h.emit("session_start", { reason: "startup" });
			const restored = restoreState(h.entries)!;
			expect(restored.mode).toBe("ssh"); expect(restored.remote!.cwd).toBe(project); expect(restored.omitDocs).toBe(true);
			const path = join(project, "ssh-tools-file");
			await h.execute("write", { path, content: "remote one\n" });
			expect(text(await h.execute("read", { path }))).toContain("remote one");
			await h.execute("edit", { path, edits: [{ oldText: "one", newText: "two" }] });
			expect((await h.execute("bash", { command: `cat ${shellQuote(path)}` })).structuredContent.output).toContain("remote two");
			const [userBash] = await h.emit("user_bash", { command: "pwd" });
			let output = ""; await userBash.operations.exec("pwd", "/unused-local-path", { onData: (data: Buffer) => { output += data.toString(); } });
			expect(output.trim()).toBe(project);
		} finally { process.env.PATH = previousPath; rmSync(link); }
	});
	// The transport maps an absolute remote prefix to a different local fixture tree.
	// Unlike a shared-path fixture, this exposes accidental host filesystem lookups.
	async function separateNamespace(prefix: string, remoteRoot: string, skill: any, run: (h: Awaited<ReturnType<typeof loaded>>) => Promise<void>) {
		const bin = mkdtempSync(join(root, "namespace-bin-")), executable = join(bin, "ssh");
		writeFileSync(executable, `#!/bin/bash\ncommand="\${@: -1}"\ncommand=\${command//${shellQuote(prefix)}/${shellQuote(remoteRoot)}}\nexec /bin/bash -c "$command"\n`); chmodSync(executable, 0o700);
		const previous = process.env.PATH; process.env.PATH = `${bin}:${previous}`;
		try {
			const h = await loaded({}, { ...policy, mode: "ssh", remote: { host: "fixture", cwd: remoteRoot, home: remoteRoot }, sshSkills: [skill.name] });
			await h.emit("before_agent_start", { systemPromptOptions: { skills: [skill] } });
			await run(h);
		} finally { process.env.PATH = previous; }
	}
	test.skipIf(process.getuid?.() === 0)("SSH read/write/edit work with skills loaded even when the same local path is inaccessible", async () => {
		const blocked = join(root, "local-root-denied"), remoteRoot = join(root, "remote-root-allowed"), skillRoot = join(root, "routing-docs");
		for (const dir of [blocked, remoteRoot, skillRoot]) mkdirSync(dir);
		const path = join(blocked, "update.sh"); chmodSync(blocked, 0o000);
		try {
			expect(() => canonicalPath(path)).toThrow("EACCES"); // Same condition as the real host's /root.
			await separateNamespace(blocked, remoteRoot, { name: "routing-docs", baseDir: skillRoot }, async (h) => {
				await h.execute("write", { path, content: "#!/bin/bash\nprintf first\n" });
				await h.execute("edit", { path, edits: [{ oldText: "first", newText: "second" }] });
				expect(text(await h.execute("read", { path }))).toContain("printf second");
				await h.execute("bash", { command: `chmod 700 ${shellQuote(path)}` });
				expect((await h.execute("bash", { command: shellQuote(path) })).structuredContent.output).toBe("second");
			});
			expect(readFileSync(join(remoteRoot, "update.sh"), "utf8")).toContain("printf second");
		} finally { chmodSync(blocked, 0o700); }
		expect(readdirSync(blocked)).toEqual([]);
	});
	test("a remote read is not redirected locally just because a host symlink points into a skill", async () => {
		const skillRoot = join(root, "collision-skill"), remoteRoot = join(root, "collision-remote"), alias = join(root, "remote-document-link");
		mkdirSync(skillRoot); mkdirSync(remoteRoot);
		writeFileSync(join(skillRoot, "document"), "LOCAL DOCUMENT"); symlinkSync(skillRoot, alias);
		writeFileSync(join(remoteRoot, "document"), "REMOTE DOCUMENT");
		await separateNamespace(alias, remoteRoot, { name: "collision", baseDir: skillRoot }, async (h) => {
			expect(text(await h.execute("read", { path: join(alias, "document") }))).toBe("REMOTE DOCUMENT");
			expect(text(await h.execute("read", { path: join(skillRoot, "document") }))).toBe("LOCAL DOCUMENT");
		});
	});
	test("relative remote paths do not become local skill reads; skill-name collisions never redirect writes", async () => {
		const skillRoot = join(project, "relative-skill"), remoteRoot = join(root, "relative-remote");
		mkdirSync(skillRoot); mkdirSync(join(remoteRoot, "relative-skill"), { recursive: true });
		writeFileSync(join(skillRoot, "document"), "LOCAL DOCUMENT"); writeFileSync(join(remoteRoot, "relative-skill/document"), "REMOTE DOCUMENT");
		await separateNamespace(skillRoot, remoteRoot, { name: "relative", baseDir: skillRoot }, async (h) => {
			expect(text(await h.execute("read", { path: "relative-skill/document" }))).toBe("REMOTE DOCUMENT");
			await h.execute("write", { path: join(skillRoot, "created"), content: "remote only" });
			await h.execute("edit", { path: join(skillRoot, "created"), edits: [{ oldText: "only", newText: "edited" }] });
			expect(readFileSync(join(remoteRoot, "created"), "utf8")).toBe("remote edited"); expect(existsSync(join(skillRoot, "created"))).toBe(false);
		});
	});
	test("SSH connection failure never falls back to local execution", async () => {
		await expect(resolveSshTarget("host", "/missing/ssh")).rejects.toThrow();
		await expect(sshBackend({ host: "h", cwd: project, home: homedir() }, "/missing/ssh").run("touch never-local")).rejects.toThrow();
		expect(existsSync(join(project, "never-local"))).toBe(false);
	});
	test("SSH keeps local AGENTS, filters skills, and can read local skills/artifacts without contacting the remote", async () => {
		const docRoot = join(root, "doc-skill"), scriptRoot = join(root, "script-skill");
		mkdirSync(docRoot); mkdirSync(join(scriptRoot, "scripts"), { recursive: true });
		writeFileSync(join(docRoot, "SKILL.md"), "local documentation");
		writeFileSync(join(scriptRoot, "scripts/run.sh"), "printf local-script");
		const skills: any[] = [{ name: "docs", baseDir: docRoot }, { name: "scripted", baseDir: scriptRoot }];
		const sshState: EnvironmentState = { ...policy, mode: "ssh", remote: { host: "unused.invalid", cwd: "/remote", home: "/root" }, sshSkills: ["@documentation"] };
		const h = await loaded({}, sshState);
		const options = { cwd: project, skills, contextFiles: [{ path: "AGENTS.md", content: "local infrastructure context" }] };
		await h.emit("before_agent_start", { systemPromptOptions: options });
		expect(options.cwd).toBe("/remote"); expect(options.skills.map((s) => s.name)).toEqual(["docs"]);
		expect(options.contextFiles[0].content).toBe("local infrastructure context");
		expect(text(await h.execute("read", { path: join(docRoot, "SKILL.md") }))).toContain("local documentation");
		await expect(h.execute("bash", { command: `bash ${shellQuote(join(scriptRoot, "scripts/run.sh"))}` })).rejects.toThrow("not enabled");
		const artifact = `/tmp/pi-codemode-${randomUUID()}.txt`; writeFileSync(artifact, "local artifact");
		try { expect(text(await h.execute("read", { path: artifact }))).toContain("local artifact"); }
		finally { rmSync(artifact, { force: true }); }
		// Explicit script enablement keeps the schema unchanged and routes only the simple call locally.
		h.entries.push({ type: "custom", customType: STATE_ENTRY, data: { ...sshState, sshSkills: ["@documentation", "scripted"] } });
		await h.emit("session_tree");
		expect(text(await h.execute("bash", { command: `bash ${shellQuote(join(scriptRoot, "scripts/run.sh"))}` }))).toContain("local-script");
	});
	test("Pi's actual jiti extension loader accepts Environment", async () => {
		const loaded = await discoverAndLoadExtensions([join(import.meta.dir, "..")], project, join(root, "empty-agent"));
		expect(loaded.errors).toEqual([]); expect(loaded.extensions.length).toBe(1);
		expect([...loaded.extensions[0].tools.keys()].sort()).toEqual(["bash", "edit", "read", "request_access", "write"]);
	}, 30000);
	test("only simple direct script calls qualify for local skill execution", () => {
		const skillRoot = join(project, "skill"); mkdirSync(join(skillRoot, "scripts"), { recursive: true });
		const script = join(skillRoot, "scripts/script.py"); writeFileSync(script, "print('ok')");
		const skill: any = { name: "fixture", baseDir: skillRoot };
		expect(localSkillScript(`python3 ${shellQuote(script)} --flag`, [skill], project)?.name).toBe("fixture");
		expect(localSkillScript(`python3 ${shellQuote(script)} 'https://example.test/?a=1&b=2'`, [skill], project)?.name).toBe("fixture");
		expect(localSkillScript(`python3 ${shellQuote(script)} "$(touch bad)"`, [skill], project)).toBeUndefined();
		expect(localSkillScript(`echo ${shellQuote(script)}`, [skill], project)).toBeUndefined();
		expect(localSkillScript(`python3 ${shellQuote(script)} && touch /somewhere`, [skill], project)).toBeUndefined();
	});
});
