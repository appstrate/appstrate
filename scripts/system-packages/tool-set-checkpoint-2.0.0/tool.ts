// SPDX-License-Identifier: Apache-2.0

/**
 * Set Checkpoint Tool — Persist a checkpoint for the next run.
 *
 * Last-write-wins. Use this for cursors, timestamps, counters, or any
 * structured data needed to resume work next time.
 *
 * AFPS 1.4: checkpoints carry an optional `scope` ("actor" | "shared").
 * - "actor" (default) keeps the checkpoint private to the run's actor
 *   (the dashboard user or end-user that triggered the run).
 * - "shared" makes the checkpoint app-wide — useful for cron-scheduled
 *   syncs that have no actor of their own.
 *
 * Replaces the deprecated `@appstrate/set-state` tool. The platform
 * accepts both `state.set` (legacy) and `checkpoint.set` events for the
 * back-compat window — new bundles should use this tool.
 */

import { Type } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const RUN_ID = process.env.AGENT_RUN_ID ?? "unknown";

function emit(obj: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ ...obj, timestamp: Date.now(), runId: RUN_ID }) + "\n");
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "set_checkpoint",
    label: "Set Checkpoint",
    description:
      "Persist a checkpoint for the next run. Last-write-wins — design the checkpoint to be self-contained. " +
      "Use for cursors, timestamps, counters, or any data needed to resume work next time. " +
      'By default the checkpoint is scoped to the run\'s actor; pass scope="shared" for app-wide.',
    parameters: Type.Object({
      data: Type.Unsafe<unknown>({
        description: "JSON value to persist as the checkpoint for the next run",
      }),
      scope: Type.Optional(
        Type.Union([Type.Literal("actor"), Type.Literal("shared")], {
          description:
            'Persistence scope. "actor" (default) keeps the checkpoint private to the run\'s actor; "shared" makes it app-wide.',
        }),
      ),
    }),

    async execute(_toolCallId, params) {
      const { data, scope } = params as { data: unknown; scope?: "actor" | "shared" };
      const event: Record<string, unknown> = { type: "checkpoint.set", data };
      if (scope !== undefined) event.scope = scope;
      emit(event);
      return {
        content: [{ type: "text", text: "Checkpoint saved" }],
        details: { data, ...(scope !== undefined ? { scope } : {}) },
      };
    },
  });
}
