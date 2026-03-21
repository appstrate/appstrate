/**
 * Report Tool — Stream narrative content to the user in Markdown format.
 *
 * Each call appends a chunk to the report, allowing the agent
 * to build it progressively while the user sees it grow in real time.
 */

import { Type } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { emitReport } from "../lib/emit.ts";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "report",
    label: "Report",
    description:
      "Append Markdown content to the user-facing report. " +
      "For short reports, a single call is fine. For longer reports, split by section so the user sees progress. " +
      "Set final to true on your last call to signal the report is complete.",
    parameters: Type.Object({
      content: Type.String({ description: "Markdown content to append to the report" }),
      final: Type.Boolean({
        description: "Set to true on the last report call to signal the report is complete",
        default: false,
      }),
    }),

    async execute(_toolCallId, params) {
      const { content, final } = params as { content: string; final?: boolean };
      emitReport(content, final ?? false);
      return {
        content: [{ type: "text", text: final ? "Report completed" : "Report chunk sent" }],
      };
    },
  });
}
