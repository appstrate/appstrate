/**
 * Log Tool — Emit user-facing log messages with explicit severity levels.
 *
 * Allows the agent to communicate progress, milestones, warnings,
 * and errors to end users via the platform's log viewer.
 */

import { Type } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { log } from "../lib/emit.ts";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "log",
    label: "Log",
    description:
      "Send a progress message to the user. Write naturally — the user reads these in real time.",
    parameters: Type.Object({
      level: Type.Union([Type.Literal("info"), Type.Literal("warn"), Type.Literal("error")], {
        description: "info: progress and milestones, warn: non-blocking issues, error: failures",
      }),
      message: Type.String({
        description: "Message for the user",
      }),
    }),

    async execute(_toolCallId, params) {
      const { level, message } = params as { level: "info" | "warn" | "error"; message: string };
      log(level, message);
      return {
        content: [{ type: "text", text: `Logged [${level}]: ${message}` }],
        details: { level, message },
      };
    },
  });
}
