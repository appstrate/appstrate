/**
 * Output Tool — Return data as part of the execution result.
 *
 * Each call is deep-merged into the final output. If an output schema
 * is defined, the merged result is validated against it.
 *
 * When OUTPUT_SCHEMA is set (JSON Schema from the flow manifest), the tool
 * parameter schema is derived from it so the LLM gets native constrained
 * decoding. `required` is stripped to allow incremental deep-merge calls.
 */

import { Type } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

function emit(obj: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function buildDataSchema() {
  const raw = process.env.OUTPUT_SCHEMA;
  if (!raw) {
    return Type.Unsafe<Record<string, unknown>>({
      type: "object",
      description: "JSON object to merge into the output",
    });
  }
  try {
    const schema = JSON.parse(raw);
    // Strip required to allow incremental deep-merge calls —
    // completeness is validated post-merge by the platform (AJV).
    const { required: _required, ...rest } = schema;
    return Type.Unsafe<Record<string, unknown>>({
      ...rest,
      description: rest.description || "JSON object to merge into the output",
    });
  } catch {
    return Type.Unsafe<Record<string, unknown>>({
      type: "object",
      description: "JSON object to merge into the output",
    });
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "output",
    label: "Output",
    description:
      "MANDATORY — call at least once before finishing. Returns data as the execution result. " +
      "Each call is deep-merged into the final output. Call with {} if you have no structured data to return.",
    parameters: Type.Object({
      data: buildDataSchema(),
    }),

    async execute(_toolCallId, params) {
      const { data } = params as { data: Record<string, unknown> };
      emit({ type: "output", data });
      return {
        content: [{ type: "text", text: "Output recorded" }],
        details: { data },
      };
    },
  });
}
