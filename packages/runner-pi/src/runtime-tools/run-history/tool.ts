// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * `run_history` runtime-injected tool — the single source of truth for
 * the tool's LLM-facing contract (name + description + parameter JSON
 * Schema).
 *
 * Fetches metadata (and optionally checkpoint/result payloads) of
 * recent past runs of the current agent. The handler-side
 * implementation lives in the sidecar (`runtime-pi/sidecar/mcp.ts`),
 * but the sidecar mirrors this descriptor's `description` + `parameters`
 * (as its MCP `inputSchema`) verbatim. This descriptor is what the
 * runtime Pi-tool registration (`mcp-forward.ts`) and the platform
 * prompt builder consume. The `description` is the LLM-facing doc —
 * surfaced via MCP `tools/list`, never via the prompt.
 */

import { defineTool } from "../define.ts";

export const runHistoryTool = defineTool({
  id: "run_history",
  name: "run_history",
  description:
    "Fetch metadata and optionally the carry-over checkpoint or final output of the agent's " +
    'most recent past runs (current run excluded). Returns JSON `{ object: "list", data: [...], hasMore }`. ' +
    "Use for trend analysis, auditing prior executions, or recovering from a failed run.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 50,
        description: "Number of past runs to return (1..50, default 10).",
      },
      fields: {
        type: "array",
        items: { type: "string", enum: ["checkpoint", "result"] },
        uniqueItems: true,
        description: "Optional subset of `{checkpoint, result}` to include per run.",
      },
    },
  },
});
