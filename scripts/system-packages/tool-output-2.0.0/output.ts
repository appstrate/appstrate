// SPDX-License-Identifier: Apache-2.0

/**
 * Output Tool — Return data as the run result.
 *
 * Single complete call: each invocation REPLACES the previous output.
 * When OUTPUT_SCHEMA is set, the schema is exposed to the LLM via the tool
 * parameters (constrained decoding) AND validated at execute time. On
 * validation failure, an error is returned to the agent so it can retry.
 */

import { Type } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import Ajv, { type ValidateFunction } from "ajv";

const RUN_ID = process.env.AGENT_RUN_ID ?? "unknown";

function emit(obj: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ ...obj, timestamp: Date.now(), runId: RUN_ID }) + "\n");
}

const ajv = new Ajv({ allErrors: true, strict: false });

function loadSchema(): {
  schema: Record<string, unknown> | null;
  validator: ValidateFunction | null;
} {
  const raw = process.env.OUTPUT_SCHEMA;
  if (!raw) return { schema: null, validator: null };
  try {
    const schema = JSON.parse(raw) as Record<string, unknown>;
    const validator = ajv.compile(schema);
    return { schema, validator };
  } catch {
    return { schema: null, validator: null };
  }
}

function buildDataSchema(schema: Record<string, unknown> | null) {
  if (!schema) {
    return Type.Unsafe<Record<string, unknown>>({
      type: "object",
      description: "JSON object to return as the run output",
    });
  }
  const description =
    typeof schema.description === "string"
      ? schema.description
      : "JSON object to return as the run output";
  return Type.Unsafe<Record<string, unknown>>({
    ...schema,
    description,
  });
}

function formatErrors(validator: ValidateFunction): string {
  return (validator.errors ?? [])
    .map((e) => `  - ${e.instancePath || "/"} ${e.message}`)
    .join("\n");
}

export default function (pi: ExtensionAPI) {
  const { schema, validator } = loadSchema();

  pi.registerTool({
    name: "output",
    label: "Output",
    description:
      "MANDATORY — call exactly once before finishing with the complete output object. " +
      "Calling again replaces the previous output. " +
      "If a schema is defined, all required fields must be provided.",
    parameters: Type.Object({
      data: buildDataSchema(schema),
    }),

    async execute(_toolCallId, params) {
      const { data } = params as { data: Record<string, unknown> };

      if (validator && !validator(data)) {
        const errors = formatErrors(validator);
        return {
          content: [
            {
              type: "text",
              text:
                `Output validation failed:\n${errors}\n\n` +
                `Please call output() again with all required fields correctly typed.`,
            },
          ],
          isError: true,
        };
      }

      emit({ type: "output.emitted", data });
      return {
        content: [{ type: "text", text: "Output recorded" }],
        details: { data },
      };
    },
  });
}
