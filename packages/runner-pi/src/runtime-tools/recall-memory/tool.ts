// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * `recall_memory` runtime-injected tool.
 *
 * Searches the agent's archive memory store. Companion to `note` (the
 * `@appstrate/note` bundle tool), which writes archive entries — both
 * back the same `package_persistence` archive surface in the platform.
 * The handler-side implementation lives in the sidecar
 * (`runtime-pi/sidecar/mcp.ts`); this descriptor is what the runtime
 * Pi-tool registration and the platform prompt builder consume.
 *
 * The sidecar advertises the same `description` so MCP `tools/list`
 * output matches the Pi-tool registration verbatim — that description is
 * the LLM-facing doc (the agent learns the tool from `tools/list`; the
 * prompt no longer carries a TOOL.md).
 */

import { defineTool } from "../define.ts";

export const recallMemoryTool = defineTool({
  id: "recall_memory",
  name: "recall_memory",
  description:
    "Search the agent's archive memories — durable facts and learnings from past runs that " +
    "are NOT in the system prompt by default. Pass `q` to filter by case-insensitive " +
    "substring; omit it for the most recent archive memories.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      q: { type: "string", minLength: 1, maxLength: 2000 },
      limit: { type: "integer", minimum: 1, maximum: 50 },
    },
  },
});
