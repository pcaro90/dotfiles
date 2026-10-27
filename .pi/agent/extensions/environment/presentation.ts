import { homedir } from "node:os";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { displayPath, MODE_ICONS, type Mode } from "./state.js";

interface EnvironmentMessage { content: unknown; details?: unknown }
export function messageText(message: EnvironmentMessage): string {
	if (typeof message.content === "string") return message.content;
	if (Array.isArray(message.content)) return message.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
	return "";
}
/** Also collapse already-persisted verbose messages from the first implementation. */
export function messageLabel(message: EnvironmentMessage): string {
	const details = message.details as { summary?: string; reason?: string } | undefined;
	const content = messageText(message);
	let label = details?.summary;
	if (!label) {
		const match = content.match(/^Environment:\s*(BUBBLE|DIRECT|SSH)\s*·\s*(.+)$/m);
		label = match ? `${MODE_ICONS[match[1].toLowerCase() as Mode]} ${displayPath(match[2])}` : `⛔ ${content.split("\n")[0]}`;
	}
	const reason = details?.reason ?? content.split("\n")[0];
	if (/^Toolchain profile refreshed/.test(reason)) label += " · ↻ toolchain";
	if (/^(Granted|Removed grant|Revoked):/.test(reason)) {
		label += " · " + reason.replace(/^Granted:\s*/, "+ ").replace(/^(Removed grant|Revoked):\s*/, "− ")
			.replace(/Personal SSH agent \(all loaded identities\)/g, "SSH agent")
			.replace(/Docker \(full access to the local daemon\)/g, "Docker")
			.replaceAll(homedir() + "/", "~/").replace(/\.$/, "");
	}
	return label;
}
export function renderEnvironmentMessage(message: EnvironmentMessage, expanded: boolean, theme: Pick<Theme, "fg">): Component {
	if (expanded) return new Text(messageText(message), 0, 0);
	const label = messageLabel(message);
	return { render: (width) => [truncateToWidth(theme.fg("muted", label), width)], invalidate() {} };
}
