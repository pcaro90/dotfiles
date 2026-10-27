import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { applyResource, decodeState, footerStatus, fullStatus, initialState, stateMessage, summary } from "../state.js";
import { bubbleArguments, bubbleMounts, privateHome, requireSocket } from "../backends.js";
import { messageLabel, renderEnvironmentMessage } from "../presentation.js";

const root = mkdtempSync(join(homedir(), ".cache/pi-environment-presentation-"));
const session = `presentation-${Date.now()}`;
afterAll(() => { rmSync(root, { recursive: true, force: true }); rmSync(dirname(privateHome(session)), { recursive: true, force: true }); });

describe("compact Environment presentation", () => {
	test("local footer is just its mode emoji; SSH retains its destination", () => {
		const state = initialState(root);
		expect(footerStatus(state)).toBe("🫧"); expect(footerStatus({ ...state, mode: "direct" })).toBe("💻");
		expect(footerStatus({ ...state, mode: "ssh", remote: { host: "moriapulsar", cwd: "/root", home: "/root" } })).toBe("🌐 moriapulsar:/root");
		expect(footerStatus(state, false)).toBe("⛔ /env");
	});
	test("bubble footer shows current SSH/Docker grants, not historical grant events", () => {
		const state = initialState(root);
		expect(footerStatus({ ...state, sshAgent: true })).toBe("🫧 🔑");
		expect(footerStatus({ ...state, docker: true })).toBe("🫧 🐳");
		const both = { ...state, sshAgent: true, docker: true };
		expect(footerStatus(both)).toBe("🫧 🔑 🐳"); expect(footerStatus(both, false)).toBe("⛔ /env");
		expect(footerStatus({ ...both, mode: "direct" })).toBe("💻");
		expect(footerStatus({ ...both, mode: "ssh", remote: { host: "fixture", cwd: "/root", home: "/root" } })).toBe("🌐 fixture:/root");
	});
	test("normal context omits toolchain inventories; explicit full status retains them", () => {
		const state = initialState(root);
		state.readPaths = Array.from({ length: 200 }, (_, i) => `/toolchain/detail-${i}`);
		expect(stateMessage(state)).not.toContain("/toolchain/detail-");
		expect(stateMessage(state).length).toBeLessThan(750);
		expect(stateMessage(state)).toContain("BUBBLE"); expect(stateMessage(state)).toContain("request_access");
		expect(fullStatus(state)).toContain("/toolchain/detail-199");
	});
	test("snapshots collapse to their summary, failures to their first line; expanded view keeps the content", () => {
		const state = initialState(root);
		const message = { content: `${stateMessage(state)}\nPolicy details`, details: { summary: summary(state), mode: "bubble" } };
		expect(messageLabel(message)).toBe(summary(state));
		expect(messageLabel({ content: "Environment initialization failed; execution is blocked.\nmore" })).toBe("⛔ Environment initialization failed; execution is blocked.");
		const theme: any = { fg: (_: string, value: string) => value };
		const collapsed = renderEnvironmentMessage(message, false, theme).render(28);
		expect(collapsed).toHaveLength(1); expect(visibleWidth(collapsed[0])).toBeLessThanOrEqual(28);
		expect(renderEnvironmentMessage(message, true, theme).render(1000).join("\n")).toContain("Policy details");
	});
});

describe("resource alias plans and socket diagnostics", () => {
	test("granted symlink files retain their requested name in a synthetic home", () => {
		const target = join(root, "source"), alias = join(root, "config-link"); writeFileSync(target, "fixture"); symlinkSync(target, alias);
		let state = initialState(join(root, "project"));
		state = applyResource(state, { type: "path", path: alias, access: "ro" });
		expect(state.pathAliases?.[alias]).toBe(target); expect(decodeState(state).pathAliases).toEqual(state.pathAliases);
		const mounts = bubbleMounts(state, session, []);
		expect(mounts.find((m) => m.path === alias)).toMatchObject({ source: target, access: "ro" });
		expect(bubbleArguments(state, mounts, "true")).toContain(alias);
		rmSync(alias);
		expect(applyResource(state, { type: "path", path: alias, access: "ro" }, false).readPaths).not.toContain(target);
	});
	test("aliases inside a mounted workspace resolve through the exposed canonical target", () => {
		const project = join(root, "project"), target = join(root, "other");
		writeFileSync(target, "fixture"); const alias = join(project, "inside-link"); symlinkSync(target, alias);
		const state = applyResource(initialState(project), { type: "path", path: alias, access: "ro" });
		const mounts = bubbleMounts(state, session, []);
		expect(mounts.find((m) => m.path === alias)).toBeUndefined();
		expect(mounts.find((m) => m.path === target)).toMatchObject({ source: target, access: "ro" });
	});
	test("automatic symlinked skill roots retain their advertised name in a private home", () => {
		const project = join(root, "project"), target = join(project, "skill-target"), registry = join(root, "skill-registry"), alias = join(registry, "linked-skill");
		mkdirSync(target); mkdirSync(registry); writeFileSync(join(target, "SKILL.md"), "fixture"); symlinkSync(target, alias);
		const state = initialState(project), mounts = bubbleMounts(state, session, [alias]);
		expect(mounts.find((m) => m.path === alias)).toMatchObject({ source: target, access: "ro" });
		expect(mounts.find((m) => m.path === target)).toMatchObject({ source: target, access: "ro" });
		expect(mounts.some((m) => m.path === registry)).toBe(false); // Not the whole user skill registry/home.
		expect(state.pathAliases).toBeUndefined(); // Derived resources are not persisted session grants.
	});
	test("a symlinked skill inside a mounted registry uses its existing link and exposed target", () => {
		const project = join(root, "project"), target = join(root, "external-skill"), alias = join(project, "linked-skill");
		mkdirSync(target); symlinkSync(target, alias);
		const mounts = bubbleMounts(initialState(project), session, [alias]);
		expect(mounts.find((m) => m.path === alias)).toBeUndefined();
		expect(mounts.find((m) => m.path === target)).toMatchObject({ source: target, access: "ro" });
	});
	test("independently linked skill files expose only their target file, not its parent", () => {
		const base = join(root, "file-skill"), target = join(root, "external-instructions.md"), alias = join(base, "SKILL.md");
		mkdirSync(base); writeFileSync(target, "fixture"); symlinkSync(target, alias);
		const mounts = bubbleMounts(initialState(join(root, "project")), session, [base, alias]);
		expect(mounts.find((m) => m.path === base)).toMatchObject({ source: base, access: "ro" });
		expect(mounts.find((m) => m.path === target)).toMatchObject({ source: target, access: "ro" });
		expect(mounts.some((m) => m.path === root)).toBe(false);
	});
	test("socket errors distinguish missing host environment from missing/invalid paths", () => {
		expect(() => requireSocket(undefined, "SSH agent")).toThrow("SSH_AUTH_SOCK is not set in the Pi host process");
		expect(() => requireSocket(join(root, "missing-socket"), "SSH agent")).toThrow("does not exist");
		const regular = join(root, "not-socket"); writeFileSync(regular, "fixture");
		expect(() => requireSocket(regular, "SSH agent")).toThrow("not a socket");
	});
});
mkdirSync(join(root, "project"));
