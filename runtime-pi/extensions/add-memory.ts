/**
 * Add Memory Tool — Save a discovery or learning as a long-term memory.
 *
 * Memories persist across all executions and are shared across
 * all users of this flow. Use this for insights worth remembering.
 */

import { Type } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { emitAddMemory } from "../lib/emit.ts";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "add_memory",
    label: "Add Memory",
    description:
      "Save a discovery or learning as a long-term memory. Memories persist across all executions and are shared " +
      "across all users of this flow. Use this for insights worth remembering " +
      "(e.g. 'Gmail API paginates at 100 results', 'User prefers CSV format').",
    parameters: Type.Object({
      content: Type.String({ description: "Memory text to save (max 2000 characters)" }),
    }),

    async execute(_toolCallId, params) {
      const { content } = params as { content: string };
      emitAddMemory(content);
      return {
        content: [{ type: "text", text: "Memory saved" }],
      };
    },
  });
}
