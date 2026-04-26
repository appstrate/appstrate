// SPDX-License-Identifier: Apache-2.0

/**
 * Note Tool — Append a discovery or learning to the long-term archive.
 *
 * AFPS 1.5: replaces `add_memory`. Archive memories are NOT injected
 * into the system prompt — the agent retrieves them on demand via the
 * `recall_memory` tool. Use this for insights worth remembering across
 * runs (e.g. "Gmail API paginates at 100 results", "User prefers CSV
 * format").
 *
 * Memories carry an optional `scope` ("actor" | "shared"):
 * - "actor" (default) keeps the note private to the run's actor.
 * - "shared" makes the note visible to every actor of this app.
 */

import { Type } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const RUN_ID = process.env.AGENT_RUN_ID ?? "unknown";

function emit(obj: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ ...obj, timestamp: Date.now(), runId: RUN_ID }) + "\n");
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "note",
    label: "Note",
    description:
      "Append a long-term archive memory — a discovery, fact, or user preference worth keeping across future runs. " +
      "Archive memories are NOT injected into the system prompt; retrieve them on demand with `recall_memory`. " +
      "By default notes are scoped to the current actor (the user or end-user that triggered the run); " +
      'pass scope="shared" for an app-wide note visible to every actor. ' +
      "Use for insights worth remembering (e.g. 'Gmail API paginates at 100 results', 'User prefers CSV format').",
    parameters: Type.Object({
      content: Type.String({ description: "Memory text to save (max 2000 characters)" }),
      scope: Type.Optional(
        Type.Union([Type.Literal("actor"), Type.Literal("shared")], {
          description:
            'Persistence scope. "actor" (default) keeps the note private to the run\'s actor; "shared" makes it app-wide.',
        }),
      ),
    }),

    async execute(_toolCallId, params) {
      const { content, scope } = params as { content: string; scope?: "actor" | "shared" };
      const event: Record<string, unknown> = { type: "memory.added", content };
      if (scope !== undefined) event.scope = scope;
      emit(event);
      return {
        content: [{ type: "text", text: "Note saved" }],
        details: { content, ...(scope !== undefined ? { scope } : {}) },
      };
    },
  });
}
