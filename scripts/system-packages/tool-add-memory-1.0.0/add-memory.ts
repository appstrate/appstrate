// SPDX-License-Identifier: Apache-2.0

/**
 * Add Memory Tool — Save a discovery or learning as a long-term memory.
 *
 * Memories persist across all runs and are shared across
 * all users of this agent. Use this for insights worth remembering.
 */

import { Type } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const RUN_ID = process.env.AGENT_RUN_ID ?? "unknown";

function emit(obj: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ ...obj, timestamp: Date.now(), runId: RUN_ID }) + "\n");
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "add_memory",
    label: "Add Memory",
    description:
      "Save a discovery or learning as a long-term memory. Memories persist across all runs and are shared " +
      "across all users of this agent. Use this for insights worth remembering " +
      "(e.g. 'Gmail API paginates at 100 results', 'User prefers CSV format').",
    parameters: Type.Object({
      content: Type.String({ description: "Memory text to save (max 2000 characters)" }),
    }),

    async execute(_toolCallId, params) {
      const { content } = params as { content: string };
      emit({ type: "memory.added", content });
      return {
        content: [{ type: "text", text: "Memory saved" }],
        details: { content },
      };
    },
  });
}
