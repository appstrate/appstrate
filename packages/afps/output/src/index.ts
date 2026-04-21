// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate contributors

import type { Tool, ToolContext, ToolResult } from "@afps-spec/schema/interfaces";

const tool: Tool = {
  name: "output",
  description:
    "Emit a structured output value. Object fields are deep-merged with prior output events (JSON merge-patch); arrays and scalars replace wholesale.",
  parameters: {
    type: "object",
    required: ["data"],
    additionalProperties: false,
    properties: {
      data: {
        description: "Structured output — objects are merge-patched.",
      },
    },
  },
  async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { data } = args as { data: unknown };
    ctx.emit({
      type: "output.emitted",
      timestamp: Date.now(),
      runId: ctx.runId,
      ...(ctx.toolCallId !== undefined ? { toolCallId: ctx.toolCallId } : {}),
      data,
    });
    return { content: [{ type: "text", text: "Output recorded" }] };
  },
};

export default tool;
export { tool };
