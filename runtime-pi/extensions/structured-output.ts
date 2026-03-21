/**
 * Structured Output Tool — Return machine-readable data as part of the execution result.
 *
 * Each call is deep-merged into the final output. If an output schema
 * is defined, the merged result is validated against it.
 */

import { Type } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { emitStructuredOutput } from "../lib/emit.ts";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "structured_output",
    label: "Structured Output",
    description:
      "Return structured data as part of the execution result. Each call is deep-merged into the final output. " +
      "Use this for machine-readable data (stats, lists, records) that complement the report. " +
      "If an output schema is defined, the merged result is validated against it.",
    parameters: Type.Object({
      data: Type.Unsafe<Record<string, unknown>>({
        type: "object",
        description: "JSON object to merge into the structured output",
      }),
    }),

    async execute(_toolCallId, params) {
      const { data } = params as { data: Record<string, unknown> };
      emitStructuredOutput(data);
      return {
        content: [{ type: "text", text: "Structured output recorded" }],
      };
    },
  });
}
