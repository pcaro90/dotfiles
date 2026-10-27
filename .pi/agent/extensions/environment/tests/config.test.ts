import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { defaultReadPaths, loadConfig, parseConfig, selectAgentSocket, type EnvironmentConfig } from "../config.js";
import { applyResource, decodeState, initialState, refreshReadProfile, restoreState, STATE_ENTRY } from "../state.js";
import { BUBBLE_AGENT_SOCKET, bubbleArguments, bubbleEnvironment, bubbleMounts, privateHome, requireSocket, sshEnvironment } from "../backends.js";

const root = mkdtempSync("/tmp/pi-environment-config-"), home = join(root, "home"), bin = join(root, "bin"), tools = join(home, "tools"), project = join(root, "project");
for (const dir of [home, bin, tools, project]) mkdirSync(dir, { recursive: true });
const config: EnvironmentConfig = { toolchain: { includePath: true, roots: ["~/tools"] }, sshAgentSocket: "/configured/agent.sock" };
afterAll(() => { rmSync(root, { recursive: true, force: true }); rmSync(dirname(privateHome(root)), { recursive: true, force: true }); });

describe("Environment configuration", () => {
	test("strict schema, clear JSON/missing-file errors, optional agent fallback", () => {
		expect(parseConfig(config)).toEqual(config);
		expect(parseConfig({ toolchain: { roots: [] } }).toolchain.includePath).toBe(true);
		expect(parseConfig({ toolchain: { roots: [] } }).sshAgentSocket).toBeNull();
		for (const invalid of [null, [], { toolchain: { roots: ["relative"] } }, { toolchain: { roots: [], includePath: "yes" } }, { toolchain: { roots: [], typo: true } }, { ...config, typo: true }, { ...config, sshAgentSocket: "$SOCKET" }]) expect(() => parseConfig(invalid)).toThrow("Invalid Environment config");
		const file = join(root, "config.json"); writeFileSync(file, "{broken");
		expect(() => loadConfig(file)).toThrow("Invalid JSON");
		expect(() => loadConfig(join(root, "absent.json"))).toThrow("Cannot read Environment config");
		writeFileSync(file, JSON.stringify(config)); expect(loadConfig(file)).toEqual(config);
	});
	test("one RO root list covers installations and prunes individual PATH targets", () => {
		const executable = join(tools, "tool"); writeFileSync(executable, "#!/bin/sh\nexit 0\n"); chmodSync(executable, 0o755);
		symlinkSync(executable, join(bin, "tool"));
		const paths = defaultReadPaths(home, bin, config);
		expect(paths).toContain(tools); expect(paths).toContain(bin); expect(paths).not.toContain(executable);
		expect(defaultReadPaths(home, "", { ...config, toolchain: { includePath: false, roots: [tools, tools + "/"] } }).filter((p) => p === tools)).toHaveLength(1);
		expect(defaultReadPaths(home, bin, { ...config, toolchain: { ...config.toolchain, includePath: false } })).not.toContain(bin);
	});
	test("one dangling link does not prevent discovering another executable target", () => {
		const otherBin = join(root, "other-bin"), executable = join(root, "external-executable"); mkdirSync(otherBin);
		writeFileSync(executable, "#!/bin/sh\nexit 0\n"); chmodSync(executable, 0o755);
		symlinkSync("/missing/tool", join(otherBin, "00-broken")); symlinkSync(executable, join(otherBin, "10-valid"));
		expect(defaultReadPaths(home, otherBin, { ...config, toolchain: { includePath: true, roots: [] } })).toContain(executable);
	});
});

describe("agent source priority", () => {
	test("defined SSH_AUTH_SOCK wins, even when empty or stale", () => {
		expect(selectAgentSocket({ SSH_AUTH_SOCK: "/forwarded/agent.sock" }, config)).toBe("/forwarded/agent.sock");
		expect(selectAgentSocket({ SSH_AUTH_SOCK: "/missing/agent.sock" }, config)).toBe("/missing/agent.sock");
		expect(selectAgentSocket({ SSH_AUTH_SOCK: "" }, config)).toBe("");
		expect(() => requireSocket("", "SSH agent")).toThrow("defined but empty");
	});
	test("configuration is used only when the environment variable is absent", () => {
		expect(selectAgentSocket({}, config)).toBe("/configured/agent.sock");
		expect(selectAgentSocket({}, { ...config, sshAgentSocket: "~/agent.sock" }, home)).toBe(join(home, "agent.sock"));
		expect(selectAgentSocket({}, { ...config, sshAgentSocket: null })).toBeUndefined();
	});
	test("the host SSH broker inherits a primary value instead of replacing it", () => {
		expect(sshEnvironment({ SSH_AUTH_SOCK: "/primary/agent.sock" }).SSH_AUTH_SOCK).toBe("/primary/agent.sock");
		expect(sshEnvironment({ SSH_AUTH_SOCK: "" }).SSH_AUTH_SOCK).toBe("");
	});
	test("a configured/detected socket is not mounted or exported until approved", async () => {
		const socket = join(root, "agent.sock"), server = createServer();
		await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
		const state = initialState(project, []), sources = { agent: socket };
		try {
			expect(bubbleEnvironment(state, sources).SSH_AUTH_SOCK).toBeUndefined();
			const denied = bubbleMounts(state, root, [], sources);
			expect(denied.some((mount) => mount.path === BUBBLE_AGENT_SOCKET)).toBe(false);
			expect(bubbleArguments(state, denied, "true", sources)).toContain("/dev/null");
			const allowed = { ...state, sshAgent: true }, mounts = bubbleMounts(allowed, root, [], sources);
			expect(mounts.find((mount) => mount.path === BUBBLE_AGENT_SOCKET)).toMatchObject({ source: socket, access: "ro" });
			expect(bubbleEnvironment(allowed, sources).SSH_AUTH_SOCK).toBe(BUBBLE_AGENT_SOCKET);
		} finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
	});
});

describe("non-destructive profile refresh", () => {
	test("changes base roots while preserving explicit RO, RW, aliases and capabilities", () => {
		const reference = join(root, "reference"), alias = join(root, "reference-alias"); writeFileSync(reference, "fixture"); symlinkSync(reference, alias);
		let state = initialState(project, ["/old/profile"]);
		state = applyResource(state, { type: "path", path: alias, access: "ro" });
		state = applyResource(state, { type: "path", path: tools, access: "rw" });
		state = { ...state, sshAgent: true, docker: true, mcpServers: ["docs"] };
		const refreshed = refreshReadProfile(state, ["/new/profile"]);
		expect(refreshed.readPaths).toEqual(["/new/profile", reference]); expect(refreshed.writePaths).toEqual(state.writePaths);
		expect(refreshed.pathAliases).toEqual(state.pathAliases); expect(refreshed.sshAgent).toBe(true); expect(refreshed.docker).toBe(true); expect(refreshed.mcpServers).toEqual(["docs"]);
		expect(state.readPaths).toContain("/old/profile"); expect(decodeState(refreshed)).toEqual(refreshed);
	});
	test("explicit grants survive being temporarily covered by a broader profile root", () => {
		const file = join(tools, "explicit-grant"); writeFileSync(file, "fixture");
		let state = applyResource(initialState(project, []), { type: "path", path: file, access: "ro" });
		state = refreshReadProfile(state, [tools]); expect(state.readPaths).toEqual([tools]);
		expect(refreshReadProfile(state, []).readPaths).toEqual([file]);
	});
	test("an explicit RO grant equal to a default remains a session grant", () => {
		const state = applyResource(initialState(project, [tools]), { type: "path", path: tools, access: "ro" });
		expect(refreshReadProfile(state, []).readPaths).toEqual([tools]);
	});
	test("the latest branch snapshot wins; state without profile metadata is rejected, not migrated", () => {
		const first = initialState(project, ["/old/profile"]);
		const last = { ...first, readPaths: [...first.readPaths, "/session/reference"] };
		const entries = (...states: unknown[]) => states.map((data) => ({ type: "custom", customType: STATE_ENTRY, data }));
		expect(restoreState(entries(first, last))!.readPaths).toEqual(last.readPaths);
		expect(() => restoreState(entries({ ...last, profileReadPaths: undefined, readGrants: undefined }))).toThrow("/env reset");
	});
});
