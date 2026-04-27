/**
 * sanitize-empty-tool-calls.ts
 *
 * Workaround for sessions that contain degenerate tool call records produced by
 * models that occasionally emit empty tool call deltas (id: "") during parallel
 * tool use.
 *
 * Without this extension, switching from such a provider to any Anthropic-based
 * model fails with:
 *   400 messages.N.content.M.tool_use.id: String should match pattern '^[a-zA-Z0-9_-]+$'
 *
 * This extension hooks into the `context` event, which fires before every LLM
 * call and receives a deep copy of the current message array. It strips:
 *   - toolCall blocks whose id is empty
 *   - toolResult messages whose toolCallId is empty
 *
 * Place in ~/.pi/agent/extensions/ for global effect, or .pi/extensions/ for
 * project-local effect.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
    pi.on("context", async (event, _ctx) => {
        const messages = event.messages
            .map((msg) => {
                if (msg.role !== "assistant") return msg;

                const original = msg.content as Array<{ type: string; id?: string }>;
                const filtered = original.filter(
                    (block) => block.type !== "toolCall" || !!block.id
                );

                if (filtered.length === original.length) return msg;
                return { ...msg, content: filtered };
            })
            .filter((msg) => {
                if (msg.role !== "toolResult") return true;
                return !!(msg as { toolCallId: string }).toolCallId;
            });

        return { messages };
    });
}
