// SPDX-License-Identifier: Apache-2.0

/**
 * Add Memory Tool — Save a discovery or learning as a long-term memory.
 *
 * AFPS 1.4: memories carry an optional `scope` ("actor" | "shared").
 * - "actor" (default) keeps the memory private to the run's actor (the
 *   dashboard user or end-user that triggered the run).
 * - "shared" makes the memory visible to every actor of this app.
 *
 * Use this for insights worth remembering across runs (e.g. "Gmail API
 * paginates at 100 results", "User prefers CSV format").
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
      "Save a discovery or learning as a long-term memory. Memories persist across all runs. " +
      "By default memories are scoped to the current actor (the user or end-user that triggered the run); " +
      'pass scope="shared" for an app-wide memory visible to every actor. ' +
      "Use for insights worth remembering (e.g. 'Gmail API paginates at 100 results', 'User prefers CSV format').",
    parameters: Type.Object({
      content: Type.String({ description: "Memory text to save (max 2000 characters)" }),
      scope: Type.Optional(
        Type.Union([Type.Literal("actor"), Type.Literal("shared")], {
          description:
            'Persistence scope. "actor" (default) keeps the memory private to the run\'s actor; "shared" makes it app-wide.',
        }),
      ),
    }),

    async execute(_toolCallId, params) {
      const { content, scope } = params as { content: string; scope?: "actor" | "shared" };
      const event: Record<string, unknown> = { type: "memory.added", content };
      if (scope !== undefined) event.scope = scope;
      emit(event);
      return {
        content: [{ type: "text", text: "Memory saved" }],
        details: { content, ...(scope !== undefined ? { scope } : {}) },
      };
    },
  });
}
