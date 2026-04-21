// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate contributors

import type { Tool, ToolContext, ToolResult } from "@afps/types";

const tool: Tool = {
  name: "log",
  description:
    "Emit a log entry with a severity level. Useful for observability — logs surface in the final RunResult but are not part of the output deliverable.",
  parameters: {
    type: "object",
    required: ["level", "message"],
    additionalProperties: false,
    properties: {
      level: { type: "string", enum: ["info", "warn", "error"] },
      message: { type: "string", minLength: 1 },
    },
  },
  async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { level, message } = args as {
      level: "info" | "warn" | "error";
      message: string;
    };
    ctx.emit({
      type: "log.written",
      timestamp: Date.now(),
      runId: ctx.runId,
      ...(ctx.toolCallId !== undefined ? { toolCallId: ctx.toolCallId } : {}),
      level,
      message,
    });
    return { content: [{ type: "text", text: "Logged" }] };
  },
};

export default tool;
export { tool };
