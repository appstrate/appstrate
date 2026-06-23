// SPDX-License-Identifier: Apache-2.0

/**
 * Thread-run discovery hook — split out of `agent-run-panel.tsx` so that file
 * exports only React components (Fast Refresh / react-refresh requirement).
 *
 * Derives every run the assistant launched, in order, from the thread's
 * `invoke_operation` calls to a run-launch operation (runAgent / runInline).
 */

import { useAuiState } from "@assistant-ui/react";

/** Platform operations that launch a run; their result carries the new run id. */
const RUN_LAUNCH_OPS = new Set(["runAgent", "runInline"]);

/**
 * Every run the assistant launched, in order, discovered from the thread's
 * `invoke_operation` calls to a run-launch operation (runAgent / runInline). The
 * run id only exists in the call RESULT (the run is created server-side), and
 * the result shape differs per engine (MCP CallToolResult / Anthropic
 * tool_result / codex structured_content), so we match the id off the
 * stringified result — engine-agnostic. Live status comes from `fetchRun` in the
 * card, not here. Returns a JSON string from the selector (stable primitive —
 * avoids re-render loops).
 */
export function useThreadRuns(): { runId: string; status?: string }[] {
  const encoded = useAuiState((s) => {
    const messages = s.thread.messages ?? [];
    const order: string[] = [];
    const seen = new Set<string>();
    for (const m of messages) {
      for (const p of m?.content ?? []) {
        if (!p || p.type !== "tool-call" || p.toolName !== "invoke_operation") continue;
        const opId = (p.args as { operation_id?: string } | undefined)?.operation_id;
        if (!opId || !RUN_LAUNCH_OPS.has(opId)) continue;
        const runId = /run_[A-Za-z0-9]+/.exec(JSON.stringify(p.result ?? ""))?.[0];
        if (!runId || seen.has(runId)) continue;
        seen.add(runId);
        order.push(runId);
      }
    }
    return JSON.stringify(order.map((runId) => ({ runId })));
  });
  return JSON.parse(encoded) as { runId: string; status?: string }[];
}
