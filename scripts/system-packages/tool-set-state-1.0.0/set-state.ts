/**
 * Set State Tool — Persist state for the next execution run.
 *
 * Only the last call is kept. Use this for cursors, timestamps,
 * counters, or any data needed to resume work next time.
 */

import { Type } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

function emit(obj: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "set_state",
    label: "Set State",
    description:
      "Persist state for the next execution run. Only the last call is kept — design the state to be self-contained. " +
      "Use this for cursors, timestamps, counters, or any data needed to resume work next time.",
    parameters: Type.Object({
      state: Type.Unsafe<Record<string, unknown>>({
        type: "object",
        description: "State object to persist for the next run",
      }),
    }),

    async execute(_toolCallId, params) {
      const { state } = params as { state: Record<string, unknown> };
      emit({ type: "set_state", state });
      return {
        content: [{ type: "text", text: "State saved" }],
        details: { state },
      };
    },
  });
}
