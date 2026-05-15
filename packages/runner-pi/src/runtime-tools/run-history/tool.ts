// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * `run_history` runtime-injected tool.
 *
 * Fetches metadata (and optionally checkpoint/result payloads) of
 * recent past runs of the current agent. The handler-side
 * implementation lives in the sidecar (`runtime-pi/sidecar/mcp.ts`);
 * this descriptor is what the runtime Pi-tool registration and the
 * platform prompt builder consume.
 *
 * If the sidecar's parameter schema or behaviour changes, update both
 * this descriptor (and the co-located `TOOL.md`) and the sidecar in
 * lockstep.
 *
 * The LLM-facing doc lives in the co-located `TOOL.md` and is resolved
 * by the platform via `loadRuntimeToolDoc(tool)` — mirroring how bundle
 * tools expose `TOOL.md` through `pkg.files.get("TOOL.md")`.
 */

import { defineTool } from "../define.ts";

export const runHistoryTool = defineTool(import.meta, {
  id: "run_history",
  name: "run_history",
  description:
    "Fetch metadata and optionally checkpoint/result of recent past runs (current run excluded).",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      limit: { type: "integer", minimum: 1, maximum: 50 },
      fields: {
        type: "array",
        items: { type: "string", enum: ["checkpoint", "result"] },
        uniqueItems: true,
      },
    },
  },
});
