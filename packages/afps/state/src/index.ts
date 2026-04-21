// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate contributors

import type { Tool, ToolContext, ToolResult } from "@afps-spec/schema/interfaces";

const tool: Tool = {
  name: "set_state",
  description:
    "Overwrite the agent's carry-over state for the next run. Last-write-wins; the most recent call fully replaces any previous state.",
  parameters: {
    type: "object",
    required: ["state"],
    additionalProperties: false,
    properties: {
      state: {
        description: "Arbitrary JSON value stored as carry-over state.",
      },
    },
  },
  async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { state } = args as { state: unknown };
    ctx.emit({
      type: "state.set",
      timestamp: Date.now(),
      runId: ctx.runId,
      ...(ctx.toolCallId !== undefined ? { toolCallId: ctx.toolCallId } : {}),
      state,
    });
    return { content: [{ type: "text", text: "State updated" }] };
  },
};

export default tool;
export { tool };
