import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { STATE_ENTRY, type EnvironmentState } from "../state.js";

const root = mkdtempSync("/tmp/pi-environment-cli-");
const local = join(root, "local"), remote = join(root, "remote"), bin = join(root, "bin");
for (const dir of [local, remote, bin]) mkdirSync(dir);
writeFileSync(join(bin, "ssh"), '#!/bin/bash\nexec /bin/bash -c "${@: -1}"\n'); chmodSync(join(bin, "ssh"), 0o700);
afterAll(() => rmSync(root, { recursive: true, force: true }));
function client(flags: string[], fakeSsh = false, extensionDir = join(import.meta.dir, "..")): RpcClient {
	return new RpcClient({
		cliPath: join(import.meta.dir, "../node_modules/@earendil-works/pi-coding-agent/dist/cli.js"), cwd: local,
		args: ["--offline", "--no-session", "--no-extensions", "--no-skills", "--no-context-files", "--no-approve", "-e", extensionDir, ...flags],
		env: fakeSsh ? { PATH: `${bin}:${process.env.PATH}` } : undefined,
	});
}
async function state(rpc: RpcClient): Promise<EnvironmentState | undefined> {
	const entry = (await rpc.getEntries()).entries.findLast((e) => e.type === "custom" && e.customType === STATE_ENTRY);
	return entry?.type === "custom" ? entry.data as EnvironmentState : undefined;
}
function copyExtension(name: string, config: string): string {
	const copied = join(root, name); mkdirSync(copied);
	for (const file of readdirSync(join(import.meta.dir, "..")).filter((entry) => entry.endsWith(".ts"))) copyFileSync(join(import.meta.dir, "..", file), join(copied, file));
	writeFileSync(join(copied, "config.json"), config);
	return copied;
}
describe("actual CLI flags through Node/RPC (no model requests)", () => {
	test("--direct is parsed by the real CLI and starts without a bubble", async () => {
		const rpc = client(["--direct"]); await rpc.start();
		try {
			expect((await state(rpc))?.mode).toBe("direct");
			expect((await rpc.bash("pwd")).output.trim()).toBe(local);
			expect(await rpc.prompt("/env status")).toBe("handled");
		} finally { await rpc.stop(); }
	}, 20000);
	test("--ssh is parsed by the real CLI and RPC bash reaches the SSH target", async () => {
		const rpc = client(["--ssh", `fixture:${remote}`], true); await rpc.start();
		try {
			const saved = await state(rpc);
			expect(saved?.mode).toBe("ssh"); expect(saved?.remote?.cwd).toBe(remote); expect(saved?.omitDocs).toBe(true);
			expect((await rpc.bash("pwd")).output.trim()).toBe(remote);
		} finally { await rpc.stop(); }
	}, 20000);
	test.skipIf(!process.env.PI_ENVIRONMENT_LIVE_SSH)("explicit opt-in: real SSH destination, default cwd and /tmp (read-only checks)", async () => {
		const rpc = client(["--ssh", process.env.PI_ENVIRONMENT_LIVE_SSH!]); await rpc.start();
		let host: string;
		try {
			const saved = await state(rpc);
			expect(saved?.mode).toBe("ssh"); host = saved!.remote!.host;
			expect((await rpc.bash("pwd")).output.trim()).toBe(saved!.remote!.cwd);
			expect((await rpc.bash("hostname")).exitCode).toBe(0);
		} finally { await rpc.stop(); }
		const withPath = client(["--ssh", `${host!}:/tmp`]); await withPath.start();
		try {
			expect((await state(withPath))?.remote?.cwd).toBe("/tmp");
			expect((await withPath.bash("pwd")).output.trim()).toBe("/tmp");
		} finally { await withPath.stop(); }
	}, 40000);
	test("invalid configuration still registers the router and blocks unrestricted RPC fallback", async () => {
		const copied = copyExtension("invalid-config-extension", "{broken");
		const rpc = client([], false, copied); await rpc.start();
		try {
			expect(await state(rpc)).toBeUndefined();
			await expect(rpc.bash("touch invalid-config-fallback")).rejects.toThrow("Invalid JSON in Environment config");
			expect(existsSync(join(local, "invalid-config-fallback"))).toBe(false);
		} finally { await rpc.stop(); }
	}, 20000);
	test("/env refresh updates a real session profile and retains session grants", async () => {
		const firstRoot = join(root, "profile-first"), nextRoot = join(root, "profile-next"), writable = join(root, "profile-writable"), reference = join(root, "profile-reference");
		for (const path of [firstRoot, nextRoot, writable]) mkdirSync(path); writeFileSync(reference, "fixture");
		const config = { toolchain: { includePath: false, roots: ["/usr", firstRoot] }, sshAgentSocket: null };
		const copied = copyExtension("refresh-config-extension", JSON.stringify(config));
		const rpc = client(["--direct"], false, copied); await rpc.start();
		try {
			expect((await state(rpc))?.readPaths).toContain(firstRoot);
			for (const command of [`/env allow ro ${reference}`, `/env allow rw ${writable}`, "/env allow mcp docs"]) expect(await rpc.prompt(command)).toBe("handled");
			config.toolchain.roots = ["/usr", nextRoot]; writeFileSync(join(copied, "config.json"), JSON.stringify(config));
			expect(await rpc.prompt("/env refresh")).toBe("handled");
			const refreshed = await state(rpc);
			expect(refreshed?.readPaths).not.toContain(firstRoot); expect(refreshed?.readPaths).toContain(nextRoot); expect(refreshed?.readPaths).toContain(reference);
			expect(refreshed?.writePaths).toContain(writable); expect(refreshed?.mcpServers).toEqual(["docs"]); expect(refreshed?.mode).toBe("direct");
			writeFileSync(join(copied, "config.json"), "{broken");
			expect(await rpc.prompt("/env refresh")).toBe("handled"); expect(await state(rpc)).toEqual(refreshed);
			expect((await rpc.bash("printf still-direct")).output).toBe("still-direct");
		} finally { await rpc.stop(); }
	}, 20000);
	for (const primary of [undefined, "/fixture/primary.sock"]) {
		test(`SSH broker source: ${primary ? "environment wins" : "configured fallback, refreshed per call"}`, async () => {
			const config = { toolchain: { includePath: false, roots: ["/usr"] }, sshAgentSocket: "/fixture/first-fallback.sock" };
			const copied = copyExtension(primary ? "primary-agent-extension" : "fallback-agent-extension", JSON.stringify(config));
			const previous = process.env.SSH_AUTH_SOCK;
			if (primary === undefined) delete process.env.SSH_AUTH_SOCK; else process.env.SSH_AUTH_SOCK = primary;
			const rpc = client(["--ssh", `fixture:${remote}`], true, copied);
			try {
				await rpc.start(); expect((await state(rpc))?.mode).toBe("ssh");
				expect((await rpc.bash('printf "%s" "$SSH_AUTH_SOCK"')).output).toBe(primary ?? config.sshAgentSocket);
				config.sshAgentSocket = "/fixture/updated-fallback.sock"; writeFileSync(join(copied, "config.json"), JSON.stringify(config));
				expect((await rpc.bash('printf "%s" "$SSH_AUTH_SOCK"')).output).toBe(primary ?? config.sshAgentSocket);
			} finally {
				await rpc.stop(); if (previous === undefined) delete process.env.SSH_AUTH_SOCK; else process.env.SSH_AUTH_SOCK = previous;
			}
		}, 20000);
	}
	test("conflicting launch flags block actual RPC execution instead of falling back", async () => {
		const rpc = client(["--direct", "--ssh", `fixture:${remote}`], true); await rpc.start();
		try {
			expect(await state(rpc)).toBeUndefined();
			await expect(rpc.bash("touch forbidden-fallback")).rejects.toThrow("mutually exclusive");
			expect(existsSync(join(local, "forbidden-fallback"))).toBe(false);
		} finally { await rpc.stop(); }
	}, 20000);
});
