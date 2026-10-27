import type { ExtensionCommandContext, ExtensionContext, Skill } from "@earendil-works/pi-coding-agent";
import { describeResource, fullStatus, stateMessage, summary, type EnvironmentState, type Mode, type Resource } from "./state.js";

export interface Controls {
	get(): EnvironmentState;
	skills(): Skill[];
	setMode(mode: Mode, ctx: ExtensionContext, target?: string): Promise<void>;
	grant(resources: Resource[], enabled: boolean, ctx: ExtensionContext): Promise<void>;
	setSkills(names: string[], ctx: ExtensionContext): Promise<void>;
	refreshProfile(ctx: ExtensionContext): Promise<void>;
}
export function resources(state: EnvironmentState): Resource[] {
	return [
		...state.readPaths.map((path): Resource => ({ type: "path", path, access: "ro" })),
		...state.writePaths.map((path): Resource => ({ type: "path", path, access: "rw" })),
		...(state.sshAgent ? [{ type: "ssh_agent" } as const] : []),
		...(state.docker ? [{ type: "docker" } as const] : []),
		...state.mcpServers.map((server): Resource => ({ type: "mcp", server })),
	];
}
export async function resourcePanel(controls: Controls, ctx: ExtensionContext): Promise<void> {
	const rows = resources(controls.get());
	if (!ctx.hasUI) { ctx.ui.notify(rows.map(describeResource).join("\n"), "info"); return; }
	const choice = await ctx.ui.select(
		"Bubble resources — select a grant to remove\nAlso available: private home/cache, loaded local skills (RO). Network open.\nNew executions only; broader grants may still permit the resource.",
		["Back", ...rows.map(describeResource)],
	);
	const index = choice ? rows.map(describeResource).indexOf(choice) : -1;
	if (index >= 0 && await ctx.ui.confirm("Remove grant?", `${describeResource(rows[index])}\nBroader grants, if any, still apply.`)) await controls.grant([rows[index]], false, ctx);
}
export async function chooseGrant(controls: Controls, ctx: ExtensionContext): Promise<void> {
	const choice = await ctx.ui.select("Grant a bubble resource for this session", ["Path: read only", "Path: read/write", "Personal SSH agent", "Docker daemon", "External MCP server"]);
	if (!choice) return;
	let resource: Resource;
	if (choice.startsWith("Path:")) {
		const path = await ctx.ui.input("Existing file or directory", "Absolute path, ~/path, or path relative to the local project");
		if (!path?.trim()) return;
		resource = { type: "path", path: path.trim(), access: choice === "Path: read only" ? "ro" : "rw" };
	} else if (choice === "Personal SSH agent") resource = { type: "ssh_agent" };
	else if (choice === "Docker daemon") resource = { type: "docker" };
	else {
		const server = await ctx.ui.input("MCP server name", "Exact configured server name");
		if (!server?.trim()) return;
		resource = { type: "mcp", server: server.trim() };
	}
	if (await ctx.ui.confirm("Grant access?", `${describeResource(resource)}\nApplies to new bubble executions; SSH agent, Docker and external MCP access are all-or-nothing.`)) await controls.grant([resource], true, ctx);
}
export async function skillsPanel(controls: Controls, ctx: ExtensionContext): Promise<void> {
	while (true) {
		const names = controls.get().sshSkills;
		const rows = controls.skills().map((skill) => ({ name: skill.name, label: skill.name }));
		const labels = rows.map((row) => `${names.includes(row.name) ? "[on]" : "[off]"} ${row.label}`);
		const choice = await ctx.ui.select("Skills offered in SSH mode\nExplicitly enabled skill scripts run in the local bubble, not on the SSH host.", ["Done", ...labels]);
		const index = choice ? labels.indexOf(choice) : -1;
		if (index < 0) return;
		const name = rows[index].name;
		await controls.setSkills(names.includes(name) ? names.filter((n) => n !== name) : [...names, name], ctx);
	}
}
export async function environmentPanel(controls: Controls, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) { ctx.ui.notify(stateMessage(controls.get()), "info"); return; }
	while (true) {
		const choice = await ctx.ui.select(
			`Environment · ${summary(controls.get())}\nResource grants are persisted in this session; existing executions are unchanged.`,
			["Change execution target", "Resources / revoke access", "Grant access", "SSH skills", "Refresh toolchain profile", "Show full status", "Close"],
		);
		if (!choice || choice === "Close") return;
		if (choice === "Resources / revoke access") await resourcePanel(controls, ctx);
		else if (choice === "Grant access") await chooseGrant(controls, ctx);
		else if (choice === "SSH skills") await skillsPanel(controls, ctx);
		else if (choice === "Refresh toolchain profile") await controls.refreshProfile(ctx);
		else if (choice === "Show full status") ctx.ui.notify(fullStatus(controls.get()), "info");
		else {
			const mode = await ctx.ui.select("Execution target", ["Bubble — local, isolated", "Direct — local, unrestricted", "SSH — remote, unrestricted"]);
			if (!mode) continue;
			if (mode.startsWith("SSH")) {
				const target = await ctx.ui.input("SSH destination", controls.get().remote ? `${controls.get().remote!.host}:${controls.get().remote!.cwd}` : "user@host:/path");
				if (target?.trim()) await controls.setMode("ssh", ctx, target.trim());
			} else await controls.setMode(mode.startsWith("Bubble") ? "bubble" : "direct", ctx);
		}
	}
}
