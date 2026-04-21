// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate contributors

/**
 * `@afps/memory` — durable-memory platform tool.
 *
 * Every call appends one memory to the run. The runtime (or a
 * business-specific EventSink) is responsible for persisting memories
 * across runs — this tool only emits the event; storage is decided at
 * the sink layer.
 *
 * See AFPS spec §8.1 (reserved core domains) for the event shape.
 */

import type { Tool, ToolContext, ToolResult } from "@afps-spec/schema/interfaces";

const tool: Tool = {
  name: "add_memory",
  description:
    "Save a durable memory — a discovery, fact, or user preference worth keeping across future runs. Prefer bullet-sized entries (one fact per call).",
  parameters: {
    type: "object",
    required: ["content"],
    additionalProperties: false,
    properties: {
      content: {
        type: "string",
        minLength: 1,
        description: "Memory content (max ~2000 chars).",
      },
    },
  },
  async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { content } = args as { content: string };
    ctx.emit({
      type: "memory.added",
      timestamp: Date.now(),
      runId: ctx.runId,
      ...(ctx.toolCallId !== undefined ? { toolCallId: ctx.toolCallId } : {}),
      content,
    });
    return { content: [{ type: "text", text: "Memory saved" }] };
  },
};

export default tool;
export { tool };
