import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import * as os from "node:os";
import { dirname, join } from "node:path";
import { BUBBLE_AGENT_SOCKET, bubbleArguments, bubbleBackend, bubbleMounts, privateHome } from "../backends.js";
import { applyResource, describeResource, initialState, refreshReadProfile, stateMessage, type EnvironmentState } from "../state.js";

async function fixture(run: (state: EnvironmentState, home: string, root: string) => void) {
	// Outside shared /tmp so it cannot accidentally grant access to symlink targets.
	const root = mkdtempSync(join(homedir(), ".cache/pi-environment-ssh-files-"));
	const home = join(root, "home"), workspace = join(root, "project"), socket = join(root, "agent.sock");
	for (const dir of [home, workspace]) mkdirSync(dir);
	const previousAgent = process.env.SSH_AUTH_SOCK;
	// Bun caches os.homedir(), so changing HOME in-process would not isolate these tests.
	const homeSpy = spyOn(os, "homedir").mockReturnValue(home);
	const server = createServer();
	try {
		await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
		process.env.SSH_AUTH_SOCK = socket;
		expect(homedir()).toBe(home);
		run(initialState(workspace, []), home, root);
	} finally {
		homeSpy.mockRestore();
		if (previousAgent === undefined) delete process.env.SSH_AUTH_SOCK; else process.env.SSH_AUTH_SOCK = previousAgent;
		await new Promise<void>((resolve) => server.close(() => resolve()));
		rmSync(root, { recursive: true, force: true });
		rmSync(dirname(privateHome(root)), { recursive: true, force: true });
	}
}

function sshFiles(home: string) {
	mkdirSync(join(home, ".ssh"));
	const config = join(home, ".ssh/config"), knownHosts = join(home, ".ssh/known_hosts"), key = join(home, ".ssh/id_ed25519");
	writeFileSync(config, "Host fixture\n  HostName example.invalid\n");
	writeFileSync(knownHosts, "fixture ssh-ed25519 fixture-key\n");
	writeFileSync(key, "private key fixture");
	return { config, knownHosts, key };
}

describe("SSH agent companion files", () => {
	test("enabling the capability adds only config/known_hosts RO and does not mutate old backends", async () => fixture((state, home, root) => {
		const { config, knownHosts, key } = sshFiles(home);
		const before = bubbleBackend(state, root);
		const allowed = applyResource(state, { type: "ssh_agent" });
		const mounts = bubbleMounts(allowed, root, []), after = bubbleBackend(allowed, root);
		for (const path of [config, knownHosts]) {
			expect(mounts.find((mount) => mount.path === path)).toMatchObject({ source: path, access: "ro" });
			expect(() => after.assertAccess!(path, false)).not.toThrow();
			expect(() => after.assertAccess!(path, true)).toThrow("Blocked by the current bubble");
		}
		expect(mounts.some((mount) => mount.path === BUBBLE_AGENT_SOCKET)).toBe(true);
		expect(mounts.some((mount) => mount.path === join(home, ".ssh") || mount.path === key)).toBe(false);
		expect(bubbleArguments(allowed, mounts, "true").join("\n")).toContain(`--ro-bind\n${config}\n${config}`);
		expect(bubbleMounts(state, root, []).some((mount) => [config, knownHosts, BUBBLE_AGENT_SOCKET].includes(mount.path))).toBe(false);
		expect(() => before.assertAccess!(config, true)).not.toThrow(); // Private-home copy, never the host file.
		expect(allowed.readPaths).toEqual(state.readPaths); expect(allowed.readGrants).toEqual([]);
		expect(stateMessage(allowed)).toContain("RO ~/.ssh/config and ~/.ssh/known_hosts");
		expect(describeResource({ type: "ssh_agent" })).toContain("RO ~/.ssh/config and ~/.ssh/known_hosts");
	}));

	test("revoking the agent removes automatic mounts but preserves explicit RO/RW grants", async () => fixture((state, home, root) => {
		const { config, knownHosts } = sshFiles(home);
		let allowed = applyResource(state, { type: "path", path: config, access: "rw" });
		allowed = applyResource(allowed, { type: "ssh_agent" });
		expect(bubbleMounts(allowed, root, []).find((mount) => mount.path === config)?.access).toBe("rw");
		const revoked = applyResource(refreshReadProfile(allowed, []), { type: "ssh_agent" }, false);
		const mounts = bubbleMounts(revoked, root, []);
		expect(mounts.find((mount) => mount.path === config)?.access).toBe("rw");
		expect(mounts.some((mount) => mount.path === knownHosts || mount.path === BUBBLE_AGENT_SOCKET)).toBe(false);
		const explicitRO = applyResource(allowed, { type: "path", path: knownHosts, access: "ro" });
		expect(bubbleMounts(applyResource(explicitRO, { type: "ssh_agent" }, false), root, []).find((mount) => mount.path === knownHosts)?.access).toBe("ro");
	}));

	test("missing files and dangling links do not prevent granting the agent", async () => fixture((state, home, root) => {
		const allowed = applyResource(state, { type: "ssh_agent" });
		expect(bubbleMounts(allowed, root, []).some((mount) => mount.path === BUBBLE_AGENT_SOCKET)).toBe(true);
		mkdirSync(join(home, ".ssh"));
		symlinkSync(join(root, "missing"), join(home, ".ssh/config"));
		writeFileSync(join(home, ".ssh/known_hosts"), "fixture");
		const mounts = bubbleMounts(allowed, root, []);
		expect(mounts.some((mount) => mount.path === join(home, ".ssh/config"))).toBe(false);
		expect(mounts.find((mount) => mount.path === join(home, ".ssh/known_hosts"))?.access).toBe("ro");
	}));

	test("symlinked .ssh and files expose only their exact RO targets and advertised names", async () => fixture((state, home, root) => {
		const directory = join(root, "ssh-directory"), target = join(root, "external-config");
		mkdirSync(directory); symlinkSync(directory, join(home, ".ssh"));
		writeFileSync(target, "Host fixture\n"); symlinkSync(target, join(directory, "config"));
		writeFileSync(join(directory, "known_hosts"), "fixture"); writeFileSync(join(directory, "id_ed25519"), "private key fixture");
		const allowed = applyResource(state, { type: "ssh_agent" }), mounts = bubbleMounts(allowed, root, []);
		const backend = bubbleBackend(allowed, root);
		for (const path of [join(home, ".ssh/config"), join(home, ".ssh/known_hosts")]) {
			expect(mounts.find((mount) => mount.path === path)).toMatchObject({ source: realpathSync(path), access: "ro" });
			expect(mounts.find((mount) => mount.path === realpathSync(path))?.access).toBe("ro");
			expect(() => backend.assertAccess!(path, false)).not.toThrow();
			expect(() => backend.assertAccess!(path, true)).toThrow("Blocked by the current bubble");
		}
		expect(mounts.some((mount) => mount.path === directory || mount.path === join(directory, "id_ed25519"))).toBe(false);
		expect(() => backend.assertAccess!(join(directory, "id_ed25519"), false)).toThrow("Blocked by the current bubble");
	}));

	test("a symlink target inside the RW workspace stays RO unless explicitly granted RW", async () => fixture((state, home, root) => {
		mkdirSync(join(home, ".ssh"));
		const target = join(state.localRoot, "ssh-config"), alias = join(home, ".ssh/config");
		writeFileSync(target, "Host fixture\n"); symlinkSync(target, alias);
		const allowed = applyResource(state, { type: "ssh_agent" });
		const mounts = bubbleMounts(allowed, root, []);
		expect(mounts.find((mount) => mount.path === target)?.access).toBe("ro");
		expect(mounts.find((mount) => mount.path === alias)?.access).toBe("ro");
		const explicit = applyResource(allowed, { type: "path", path: alias, access: "rw" });
		const backend = bubbleBackend(explicit, root);
		expect(() => backend.assertAccess!(alias, true)).not.toThrow();
		expect(bubbleMounts(explicit, root, []).find((mount) => mount.path === alias)?.access).toBe("rw");
	}));

	test("non-file companion paths fail closed instead of exposing a directory", async () => fixture((state, home, root) => {
		mkdirSync(join(home, ".ssh/config"), { recursive: true });
		expect(() => bubbleMounts(applyResource(state, { type: "ssh_agent" }), root, [])).toThrow("not a regular file");
		expect(() => bubbleMounts(state, root, [])).not.toThrow();
	}));
});
