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
 * The sidecar advertises the same `description` so MCP-list output
 * matches the Pi-tool registration verbatim.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { RuntimeInjectedTool } from "../types.ts";

// Co-locate the LLM-facing doc as `TOOL.md` next to this descriptor
// (mirrors the bundle-tool layout). Loaded synchronously at module-
// import time so the descriptor is fully populated before any
// consumer reads `RUNTIME_INJECTED_TOOLS`.
const doc = readFileSync(fileURLToPath(new URL("./TOOL.md", import.meta.url)), "utf8");

export const recallMemoryTool: RuntimeInjectedTool = {
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
  doc,
};
