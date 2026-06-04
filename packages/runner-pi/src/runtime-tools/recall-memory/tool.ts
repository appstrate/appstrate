// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * `recall_memory` runtime-injected tool — the single source of truth for
 * the tool's LLM-facing contract (name + description + parameter JSON
 * Schema).
 *
 * Searches the agent's archive memory store. Companion to `note` (the
 * `@appstrate/note` bundle tool), which writes archive entries — both
 * back the same `package_persistence` archive surface in the platform.
 * The handler-side implementation lives in the sidecar
 * (`runtime-pi/sidecar/mcp.ts`), but the sidecar mirrors this
 * descriptor's `description` + `parameters` (as its MCP `inputSchema`)
 * verbatim. This descriptor is what the runtime Pi-tool registration
 * (`mcp-forward.ts`) and the platform prompt builder consume — that
 * description is the LLM-facing doc (the agent learns the tool from
 * `tools/list`; the prompt no longer carries a TOOL.md).
 */

import { defineTool } from "../define.ts";

export const recallMemoryTool = defineTool({
  id: "recall_memory",
  name: "recall_memory",
  description:
    "Search the agent's archive memories — durable facts and learnings from past runs that " +
    "are NOT visible in the system prompt by default. Pass an optional `q` to filter by " +
    "case-insensitive substring; omit it to retrieve the most recent archive memories. " +
    "Use this when the prompt's `## Memory` section says you have archived memories worth " +
    "checking, when looking for a fact you remember saving, or before answering a question " +
    "that depends on prior-session context. Returns JSON `{ memories: [...] }`.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      q: {
        type: "string",
        minLength: 1,
        maxLength: 2000,
        description:
          "Case-insensitive substring to match against memory content (text or JSON). " +
          "Omit for an unfiltered most-recent-first slice.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 50,
        description: "Max memories to return (1..50, default 10).",
      },
    },
  },
});
