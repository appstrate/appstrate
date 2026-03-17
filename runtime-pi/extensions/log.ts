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
      "Send a user-facing log message. Use this to report progress, milestones, warnings, or errors to the user. " +
      "Levels: info (progress & milestones), warn (unexpected but non-blocking), error (failures).",
    parameters: Type.Object({
      level: Type.Union([Type.Literal("info"), Type.Literal("warn"), Type.Literal("error")], {
        description: "Severity level: info for progress/milestones, warn for non-blocking issues, error for failures",
      }),
      message: Type.String({
        description: "Human-readable message for the user (e.g. '42 emails processed', '3 contacts skipped — no email address')",
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
