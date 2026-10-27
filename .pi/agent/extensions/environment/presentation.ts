import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";

interface EnvironmentMessage { content: unknown; details?: unknown }
export function messageText(message: EnvironmentMessage): string {
	if (typeof message.content === "string") return message.content;
	if (Array.isArray(message.content)) return message.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
	return "";
}
/** Policy snapshots carry their summary; initialization failures show their first line. */
export function messageLabel(message: EnvironmentMessage): string {
	return (message.details as { summary?: string } | undefined)?.summary ?? `⛔ ${messageText(message).split("\n")[0]}`;
}
export function renderEnvironmentMessage(message: EnvironmentMessage, expanded: boolean, theme: Pick<Theme, "fg">): Component {
	if (expanded) return new Text(messageText(message), 0, 0);
	const label = messageLabel(message);
	return { render: (width) => [truncateToWidth(theme.fg("muted", label), width)], invalidate() {} };
}
