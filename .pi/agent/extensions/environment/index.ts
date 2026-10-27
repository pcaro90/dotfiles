/** Environment: local Bubblewrap, local direct, and SSH execution under one tool router. */
import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI, ExtensionContext, Skill } from "@earendil-works/pi-coding-agent";
import { Text, type KeyId } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	bubbleBackend, directBackend, localPath, remotePath, probeBubble, resolveSshTarget, sshBackend,
	requireSocket, sshAgentSocket, dockerSocket, type Backend,
} from "./backends.js";
import {
	STATE_ENTRY, MESSAGE_TYPE, initialState, restoreState, applyResource, canonicalPath, commandWords,
	describeResource, footerStatus, fullStatus, inside, policyKey, refreshReadProfile, stateMessage, summary, type EnvironmentState, type Mode, type Resource,
} from "./state.js";
import { bashOperations, registerEnvironmentTools } from "./tools.js";
import { environmentPanel, resourcePanel, skillsPanel, type Controls } from "./ui.js";
import { renderEnvironmentMessage } from "./presentation.js";

const ResourceSchema = Type.Union([
	Type.Object({ type: Type.Literal("path"), path: Type.String({ minLength: 1 }), access: Type.Union([Type.Literal("ro"), Type.Literal("rw")]) }),
	Type.Object({ type: Type.Literal("ssh_agent") }),
	Type.Object({ type: Type.Literal("docker") }),
	Type.Object({ type: Type.Literal("mcp"), server: Type.String({ minLength: 1, pattern: "^[A-Za-z0-9_-]+$" }) }),
]);
const interpreters = new Set(["bash", "sh", "node", "bun", "python", "python2", "python3", "ruby", "perl", "php"]);
const basicTools = new Set(["read", "write", "edit", "bash", "codemode", "request_access", "questionnaire", "tool_search"]);
const unsupportedTools = new Set(["grep", "find", "ls", "powershell"]);
const artifactPattern = /^pi-(?:bash|codemode|mcp|tool|read|image)-[a-zA-Z0-9_.-]+$/;

/** A routing convention, not a Bash permission parser: operators/substitutions need a separate call. */
function standaloneCommand(command: string): boolean {
	let quote = "";
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (ch === "\\" && quote !== "'") { i++; continue; }
		if ((ch === "'" || ch === '\"') && (!quote || quote === ch)) { quote = quote ? "" : ch; continue; }
		if (quote !== "'" && (ch === "`" || (ch === "$" && command[i + 1] === "("))) return false;
		if (!quote && /[;&|<>()\n]/.test(ch)) return false;
	}
	return !quote;
}
/** Only direct, standalone calls to explicitly enabled scripts may select the local backend in SSH. */
export function localSkillScript(command: string, skills: Skill[], cwd: string): Skill | undefined {
	if (!standaloneCommand(command)) return undefined;
	let words: string[];
	try { words = commandWords(command); } catch { return undefined; }
	let script = words[0];
	if (interpreters.has(basename(script ?? ""))) script = words[1];
	if (!script || !script.startsWith("/")) return undefined;
	const lexical = localPath(script, cwd);
	const candidates = skills.filter((skill) => inside(lexical, resolve(skill.baseDir, "scripts")));
	if (!candidates.length) return undefined; // Other absolute commands belong to the remote; never stat them locally.
	const path = canonicalPath(lexical);
	return candidates.find((skill) => inside(path, canonicalPath(resolve(skill.baseDir, "scripts"))) && existsSync(path));
}
export function withoutDocs<T>(messages: T[]): T[] {
	return messages.map((message: any) => {
		if (message.role !== "system" || !message.sections || !("docs" in message.sections)) return message;
		const sections = { ...message.sections }; delete sections.docs;
		return { ...message, sections };
	});
}
export default function environment(pi: ExtensionAPI): void {
	// Register the router even if config.json is broken: session_start must fail closed,
	// rather than a factory exception leaving Pi's unrestricted built-ins in place.
	let state = initialState(process.cwd(), []);
	state.sshSkills = ["@documentation"];
	let sessionBase = structuredClone(state);
	let allSkills: Skill[] = [];
	let sessionId = "uninitialized";
	let ready = false;
	let failure = "Environment has not initialized; no execution is allowed.";
	let inFlight = 0;
	let announced: string | undefined;
	let approvalQueue: Promise<unknown> = Promise.resolve();
	let shortcutQueue: Promise<unknown> = Promise.resolve();
	let generation = 0;

	pi.registerFlag("ssh", { description: "SSH destination: user@host or user@host:/path", type: "string" });
	pi.registerFlag("direct", { description: "Run tools directly on the local host, without Bubblewrap", type: "boolean", default: false });
	pi.registerMessageRenderer(MESSAGE_TYPE, (message, { expanded }, theme) => renderEnvironmentMessage(message, expanded, theme));
	const selectedSkills = () => state.mode !== "ssh" ? allSkills : allSkills.filter((skill) =>
		state.sshSkills.includes(skill.name) || (state.sshSkills.includes("@documentation") && !existsSync(resolve(skill.baseDir, "scripts"))),
	);
	// Keep the names advertised by Pi. An independently linked instruction file also
	// needs its target, but ordinary files must inherit an explicit RW directory grant.
	const skillPaths = (skills: Skill[]) => skills.flatMap((skill) => {
		const root = resolve(skill.baseDir), paths = [root];
		if (skill.filePath && !inside(canonicalPath(resolve(skill.filePath)), canonicalPath(root))) paths.push(resolve(skill.filePath));
		return paths;
	});
	const skillRoots = () => skillPaths(selectedSkills());
	const materializeSshSkills = () => {
		if (!state.sshSkills.includes("@documentation")) return;
		state = { ...state, sshSkills: [...new Set([
			...state.sshSkills.filter((name) => name !== "@documentation"),
			...allSkills.filter((skill) => !existsSync(resolve(skill.baseDir, "scripts"))).map((skill) => skill.name),
		])] };
		pi.appendEntry(STATE_ENTRY, structuredClone(state));
	};
	const ensureReady = () => { if (!ready) throw new Error(failure); };
	const localBubble = () => bubbleBackend(structuredClone(state), sessionId, skillRoots());
	const backend = (): Backend => {
		ensureReady();
		if (state.mode === "direct") return directBackend(state.localRoot);
		if (state.mode === "ssh") return sshBackend(state.remote!);
		return localBubble();
	};
	const track = async <T>(run: () => Promise<T>): Promise<T> => { inFlight++; try { return await run(); } finally { inFlight--; } };
	const status = (ctx: ExtensionContext) => {
		const color = !ready ? "error" : state.mode === "direct" ? "warning" : "accent";
		ctx.ui.setStatus("environment", ctx.ui.theme.fg(color, footerStatus(state, ready)));
	};
	const restoreAnnouncement = (ctx: ExtensionContext) => {
		announced = undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "compaction" || entry.type === "branch_summary") announced = undefined;
			const details = entry.type === "custom_message" && entry.customType === MESSAGE_TYPE ? entry.details
				: entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "request_access" ? entry.message.details : undefined;
			const key = (details as { policy?: unknown })?.policy;
			if (typeof key === "string") announced = key;
		}
	};
	const persist = (ctx: ExtensionContext) => {
		pi.appendEntry(STATE_ENTRY, structuredClone(state));
		status(ctx);
	};
	const validateResources = (resources: Resource[], enabled: boolean) => {
		let candidate = structuredClone(state);
		for (const resource of resources) {
			if (enabled && resource.type === "ssh_agent") requireSocket(sshAgentSocket(), "SSH agent");
			if (enabled && resource.type === "docker") requireSocket(dockerSocket(), "Docker");
			if (resource.type === "mcp" && !/^[A-Za-z0-9_-]+$/.test(resource.server)) throw new Error("Invalid MCP server name.");
			candidate = applyResource(candidate, resource, enabled);
		}
		return candidate;
	};
	const controls: Controls = {
		get: () => structuredClone(state), skills: () => allSkills,
		async setMode(mode, ctx, target) {
			if (!ctx.isIdle() || inFlight) throw new Error("Wait for the current turn/tools to finish, or stop them before changing execution target.");
			const previous = state, requestedGeneration = generation;
			const candidate = structuredClone(state);
			if (mode === "ssh") {
				if (!target && !candidate.remote) throw new Error("Specify /env ssh user@host:/path.");
				candidate.remote = await resolveSshTarget(target ?? `${candidate.remote!.host}:${candidate.remote!.cwd}`);
			}
			if (mode === "bubble") await probeBubble(candidate, sessionId, skillPaths(allSkills));
			if (!ctx.isIdle() || inFlight) throw new Error("Execution started while changing target; stop it and retry the mode change.");
			if (state !== previous || generation !== requestedGeneration) throw new Error("Environment changed while selecting the execution target; retry.");
			candidate.mode = mode;
			state = candidate; ready = true; failure = "";
			persist(ctx);
			ctx.ui.notify(`Environment → ${summary(state)}`, mode === "direct" ? "warning" : "info");
		},
		async grant(resources, enabled, ctx) {
			if (!ready && state.mode !== "bubble") ensureReady();
			const previous = state, requestedGeneration = generation;
			const candidate = validateResources(resources, enabled);
			// Missing mounts or invalid socket grants must not partially modify the policy.
			if (candidate.mode === "bubble") await probeBubble(candidate, sessionId, skillRoots());
			if (state !== previous || generation !== requestedGeneration) throw new Error("Environment changed while validating this grant; retry with the current policy.");
			state = candidate; ready = true; failure = "";
			persist(ctx);
		},
		async refreshProfile(ctx) {
			if (!ready && state.mode !== "bubble") ensureReady();
			const previous = state;
			const candidate = refreshReadProfile(state);
			if (candidate.mode === "bubble") await probeBubble(candidate, sessionId, skillRoots());
			if (state !== previous) throw new Error("Environment changed while refreshing the profile; retry.");
			if (ready && JSON.stringify(candidate) === JSON.stringify(state)) {
				ctx.ui.notify("Toolchain profile is already up to date.", "info");
				return;
			}
			state = candidate; ready = true; failure = "";
			persist(ctx);
		},
		async setSkills(names, ctx) {
			ensureReady();
			state = { ...state, sshSkills: [...new Set(names)] };
			persist(ctx);
		},
	};

	// Serialize rapid key presses, including mixed capability/mode changes. Each action
	// reads the latest policy; actions queued by an old session/runtime must not publish.
	const shortcut = (key: KeyId, description: string, run: (ctx: ExtensionContext) => Promise<void>) => pi.registerShortcut(key, {
		description,
		async handler(ctx) {
			const requestedGeneration = generation;
			const operation = shortcutQueue.then(async () => {
				if (requestedGeneration !== generation) return;
				ensureReady();
				await run(ctx);
			});
			shortcutQueue = operation.catch(() => {});
			try { await operation; }
			catch (error) { if (requestedGeneration === generation) ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
		},
	});
	for (const [key, type, flag] of [["ctrl+1", "ssh_agent", "sshAgent"], ["ctrl+2", "docker", "docker"]] as const) {
		shortcut(key, `Toggle bubble ${type === "ssh_agent" ? "SSH agent (🔑)" : "Docker (🐳)"} access`, async (ctx) => {
			if (state.mode !== "bubble") { ctx.ui.notify("Capability shortcuts apply only in bubble mode; use /env bubble first.", "info"); return; }
			await controls.grant([{ type }], !state[flag], ctx);
		});
	}
	shortcut("ctrl+tab", "Toggle local bubble / unrestricted direct execution", async (ctx) => {
		if (state.mode === "ssh") { ctx.ui.notify("Ctrl+Tab does not leave SSH. Select a local target explicitly with /env.", "info"); return; }
		await controls.setMode(state.mode === "bubble" ? "direct" : "bubble", ctx);
	});

	registerEnvironmentTools(pi, {
		localRoot: () => state.localRoot, backend, track,
		file(path, mutation) {
			ensureReady();
			if (state.mode !== "ssh") return { backend: backend(), path: localPath(path, state.localRoot) };
			// Mutations always belong to SSH. Local read exceptions require an explicit
			// absolute skill/artifact path, never a realpath lookup of an arbitrary remote name.
			const requested = path.startsWith("@") ? path.slice(1) : path;
			if (!mutation && isAbsolute(requested)) {
				const local = resolve(requested);
				const skill = allSkills.find((s) => inside(local, resolve(s.baseDir)));
				if (skill) {
					if (!selectedSkills().some((s) => s.name === skill.name)) throw new Error(`Skill ${skill.name} is not enabled in SSH mode. The user can change this with /env skills.`);
					return { backend: directBackend(state.localRoot), path: local };
				}
				if (resolve(dirname(local)) === resolve(tmpdir()) && artifactPattern.test(basename(local)) && existsSync(local)) return { backend: directBackend(state.localRoot), path: local };
			}
			return { backend: backend(), path: remotePath(path, state.remote!) };
		},
		bash(command) {
			ensureReady();
			if (state.mode === "ssh") {
				const scriptSkill = localSkillScript(command, allSkills, state.localRoot);
				if (scriptSkill) {
					if (!selectedSkills().some((s) => s.name === scriptSkill.name)) throw new Error(`Local scripts of skill ${scriptSkill.name} are not enabled in SSH mode. Ask the user to enable it with /env skills.`);
					return localBubble();
				}
				if (allSkills.some((s) => command.includes(s.baseDir))) throw new Error("This SSH bash command mentions a local skill but is not a standalone script invocation. Use read for local skill files, or invoke an enabled script by absolute path in its own bash call; mixed local/remote commands are not routed implicitly.");
			}
			return backend();
		},
	});
	pi.on("user_bash", () => ({ operations: bashOperations(backend(), track) }));

	pi.registerTool({
		name: "request_access", label: "Request access", exposure: "model-only",
		description: "Ask the user to grant local bubble resources for this session: RO/RW paths, personal SSH agent, Docker, or an external MCP server. Does not change execution mode or retry commands. Existing executions are unaffected.",
		parameters: Type.Object({ resources: Type.Array(ResourceSchema, { minItems: 1, maxItems: 20 }), reason: Type.String({ minLength: 1 }) }),
		async execute(_id, params, signal, _update, ctx) {
			const requestGeneration = generation;
			const operation = approvalQueue.then(async () => {
				ensureReady();
				if (signal?.aborted || requestGeneration !== generation) throw new Error("aborted");
				if (!ctx.hasUI) throw new Error("Access not granted: no approval UI is available. The user can configure access with /env.");
				let requested = params.resources as Resource[];
				validateResources(requested, true);
				const choice = await ctx.ui.select(`Environment access request\n${params.reason}\n\n${requested.map(describeResource).join("\n")}\n\nSession grants; new executions only.`, ["Allow", "Adjust paths / access", "Deny"], { signal });
				if (choice === "Adjust paths / access") {
					const adjusted: Resource[] = [];
					for (const resource of requested) {
						if (resource.type !== "path") { adjusted.push(resource); continue; }
						const path = await ctx.ui.input("Grant path", resource.path, { signal });
						if (!path?.trim()) return accessResult(false, [], "Cancelled by user.");
						const access = await ctx.ui.select(`Access to ${path}`, ["RO", "RW"], { signal });
						if (!access) return accessResult(false, [], "Cancelled by user.");
						adjusted.push({ type: "path", path: path.trim(), access: access === "RW" ? "rw" : "ro" });
					}
					requested = adjusted;
					if (!await ctx.ui.confirm("Grant adjusted resources?", requested.map(describeResource).join("\n"), { signal })) return accessResult(false, [], "Denied by user.");
				} else if (choice !== "Allow") return accessResult(false, [], "Denied by user. Do not work around this denial.");
				if (signal?.aborted || requestGeneration !== generation) throw new Error("aborted");
				await controls.grant(requested, true, ctx);
				if (signal?.aborted || requestGeneration !== generation) throw new Error("aborted");
				announced = policyKey(state);
				return accessResult(true, requested, `Granted for this session; no automatic retry.\n${stateMessage(state)}`, announced);
			});
			approvalQueue = operation.catch(() => {});
			return operation;
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", "request_access ") + theme.fg("muted", args.reason ?? ""), 0, 0); },
	});

	pi.registerCommand("env", {
		description: "Environment: execution target, bubble resources, and SSH skills",
		getArgumentCompletions(prefix) {
			return ["status", "bubble", "direct", "ssh", "resources", "allow", "revoke", "skills", "refresh", "reset"].filter((s) => s.startsWith(prefix)).map((value) => ({ value, label: value }));
		},
		async handler(args, ctx) {
			try {
				const options = ctx.getSystemPromptOptions?.();
				if (options?.skills) { allSkills = options.skills; if (ready) materializeSshSkills(); }
				const [action, ...rest] = commandWords(args);
				if (action === "reset") {
					if (!ctx.isIdle() || inFlight) throw new Error("Stop the current turn before resetting Environment.");
					const candidate = initialState(ctx.cwd); candidate.sshSkills = ["@documentation"]; candidate.omitDocs = state.omitDocs;
					await probeBubble(candidate, sessionId, skillPaths(allSkills));
					state = candidate; ready = true; failure = ""; persist(ctx); return;
				}
				if (action === "refresh") { await controls.refreshProfile(ctx); return; }
				if (action === "bubble" || action === "direct" || action === "ssh") { await controls.setMode(action, ctx, rest.join(" ") || undefined); return; }
				if (!["", "status", "resources", "allow", "revoke"].includes(action ?? "")) ensureReady();
				if (!action) await environmentPanel(controls, ctx);
				else if (action === "status") ctx.ui.notify(rest[0] === "full" ? fullStatus(state) : stateMessage(state), "info");
				else if (action === "resources") await resourcePanel(controls, ctx);
				else if (action === "skills") { if (!ctx.hasUI) throw new Error("Use interactive /env skills to select SSH skills."); await skillsPanel(controls, ctx); }
				else if (action === "allow" || action === "revoke") {
					const [kind, ...value] = rest;
					let resource: Resource;
					if (kind === "ro" || kind === "rw") { if (!value.length) throw new Error("Specify a path."); resource = { type: "path", path: value.join(" "), access: kind }; }
					else if (kind === "ssh-agent") resource = { type: "ssh_agent" };
					else if (kind === "docker") resource = { type: "docker" };
					else if (kind === "mcp" && value.length === 1) resource = { type: "mcp", server: value[0] };
					else throw new Error("Usage: /env allow|revoke ro|rw PATH | ssh-agent | docker | mcp SERVER");
					await controls.grant([resource], action === "allow", ctx);
				} else throw new Error("Usage: /env [status|bubble|direct|ssh HOST[:PATH]|resources|allow|revoke|skills|refresh|reset]");
			} catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
		},
	});

	pi.on("session_start", async (event, ctx) => {
		generation++; ready = false; restoreAnnouncement(ctx); allSkills = []; approvalQueue = Promise.resolve(); shortcutQueue = Promise.resolve();
		ctx.ui.setStatus("working-mode", undefined); ctx.ui.setStatus("ssh", undefined);
		sessionId = ctx.sessionManager.getSessionId();
		try {
			const saved = restoreState(ctx.sessionManager.getBranch());
			state = saved ?? initialState(ctx.cwd);
			if (!saved) state.sshSkills = ["@documentation"];
			// Explicit flags win on process startup and initialize new/legacy sessions. A
			// saved Environment policy wins on /reload and in-process session switches.
			const ssh = pi.getFlag("ssh") as string | undefined;
			const direct = pi.getFlag("direct") === true;
			const useFlags = event.reason === "startup" || !saved;
			if (useFlags && ssh && direct) throw new Error("--ssh and --direct are mutually exclusive. Use /env to select a destination.");
			if (useFlags && ssh) { state.remote = await resolveSshTarget(ssh); state.mode = "ssh"; }
			else if (useFlags && direct) state.mode = "direct";
			if (!saved) state.omitDocs = state.mode === "ssh";
			sessionBase = structuredClone(state);
			if (state.mode === "bubble") await probeBubble(state, sessionId);
			ready = true; failure = "";
			pi.appendEntry(STATE_ENTRY, structuredClone(state));
			// Only remove unsupported built-ins; do not confuse codemode/deferred exposure with an inactive permission.
			pi.setActiveTools([...new Set([...pi.getActiveTools().filter((name) => !unsupportedTools.has(name)), "read", "write", "edit", "bash", "codemode", "request_access"])]);
		} catch (error) {
			failure = `Environment initialization failed; execution is blocked, with no local fallback. ${error instanceof Error ? error.message : String(error)}`;
			ctx.ui.notify(failure, "error");
		}
		status(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => {
		generation++; ready = false; restoreAnnouncement(ctx);
		try {
			state = restoreState(ctx.sessionManager.getBranch()) ?? structuredClone(sessionBase);
			if (state.mode === "bubble") await probeBubble(state, sessionId, skillRoots());
			ready = true; failure = "";
		} catch (error) { failure = `Environment restoration failed; execution is blocked. ${String(error)}`; ctx.ui.notify(failure, "error"); }
		status(ctx);
	});
	pi.on("session_compact", () => { announced = undefined; });
	pi.on("session_shutdown", () => { generation++; ready = false; });
	pi.on("before_agent_start", (event) => {
		allSkills = event.systemPromptOptions.skills ?? [];
		if (ready) materializeSshSkills();
		if (state.mode === "ssh") {
			event.systemPromptOptions.cwd = state.remote?.cwd ?? state.localRoot;
			event.systemPromptOptions.skills = selectedSkills();
		}
		// Keep project_context and all local AGENTS.md instructions exactly as Pi loaded them.
		const key = ready ? policyKey(state) : failure;
		if (key === announced) return;
		const changed = announced !== undefined;
		announced = key;
		return { message: { customType: MESSAGE_TYPE, content: ready ? stateMessage(state) : failure, display: !ready || changed,
			details: ready ? { summary: summary(state), mode: state.mode, policy: key } : undefined } };
	});
	pi.on("context_with_system", (event) => state.omitDocs ? { messages: withoutDocs(event.messages) } : undefined);
	pi.on("tool_call", (event) => {
		if (!ready && event.toolName !== "questionnaire") return { block: true, reason: failure };
		if (unsupportedTools.has(event.toolName)) return { block: true, reason: "Environment uses read/write/edit/bash; use bash for listing and searching." };
		if (state.mode !== "bubble" || basicTools.has(event.toolName)) return;
		const tool = pi.getAllTools().find((t) => t.name === event.toolName);
		const namespace = tool?.namespace?.name;
		const server = namespace?.startsWith("mcp__") ? namespace.slice(5) : event.toolName.match(/^mcp__(.*?)__/s)?.[1];
		if (server) {
			if (state.mcpServers.includes(server)) return;
			return { block: true, reason: `External MCP server ${server} runs outside the local bubble. Ask the user with request_access for this MCP server; tools are not isolated merely because codemode calls them.` };
		}
		if (["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"].includes(event.toolName)) {
			const requested = (event.input as { server?: string }).server;
			if (requested && state.mcpServers.includes(requested)) return;
			return { block: true, reason: "Specify an authorized MCP server. Ask the user with request_access for external MCP access first." };
		}
		return { block: true, reason: `Tool ${event.toolName} has no Environment bubble backend. Use the four basic tools; external integrations need an explicit adapter.` };
	});
}
function accessResult(granted: boolean, resources: Resource[], message: string, policy?: string) {
	return { content: [{ type: "text" as const, text: message + (resources.length ? `\n${resources.map(describeResource).join("\n")}` : "") }], details: { granted, resources, ...(policy ? { policy } : {}) } };
}
