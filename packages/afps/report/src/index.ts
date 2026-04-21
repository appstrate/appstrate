// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate contributors

import type { Tool, ToolContext, ToolResult } from "@afps/types";

const tool: Tool = {
  name: "report",
  description:
    "Append a line to the human-readable run report. Lines are concatenated with newline separators in the final RunResult.",
  parameters: {
    type: "object",
    required: ["content"],
    additionalProperties: false,
    properties: {
      content: {
        type: "string",
        description: "One line of the human-readable report.",
      },
    },
  },
  async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { content } = args as { content: string };
    ctx.emit({
      type: "report.appended",
      timestamp: Date.now(),
      runId: ctx.runId,
      ...(ctx.toolCallId !== undefined ? { toolCallId: ctx.toolCallId } : {}),
      content,
    });
    return { content: [{ type: "text", text: "Report line appended" }] };
  },
};

export default tool;
export { tool };
