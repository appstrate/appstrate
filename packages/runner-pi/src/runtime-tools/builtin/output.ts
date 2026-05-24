// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Output built-in tool — Return data as the run result.
 *
 * Single complete call: each invocation REPLACES the previous output.
 * When OUTPUT_SCHEMA is set, the schema is exposed to the LLM via the tool
 * parameters (constrained decoding) AND validated at execute time. On
 * validation failure, an error is returned to the agent so it can retry.
 *
 * Formerly the `@appstrate/output` tool package; baked into the runtime
 * image after the `tool` package type was removed. Behaviour (stdout
 * `output.emitted` event → run-result aggregate) is unchanged.
 */

import { Type } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionFactory } from "@mariozechner/pi-coding-agent";
import Ajv, { type ValidateFunction } from "ajv";
import { emit } from "./emit.ts";

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

export const outputTool: ExtensionFactory = (pi: ExtensionAPI) => {
  const { schema, validator } = loadSchema();

  // This tool is opt-in (the agent selects it via `runtimeTools`). When it
  // IS present, whether the agent MUST call it depends on whether this run
  // declares an output schema. With a schema, the run promises a typed
  // result — calling `output` (once, valid) is required. Without a schema,
  // the agent may simply perform its task and finish without emitting output
  // (a side-effect-only run is a valid success).
  const description = schema
    ? "Call exactly once before finishing with the complete output object that satisfies " +
      "the declared schema (all required fields must be provided). Calling again replaces " +
      "the previous output."
    : "Optional — call at most once to return a JSON object as the run result. " +
      "If your task produces no result to return, finish without calling it. " +
      "Calling again replaces the previous output.";

  pi.registerTool({
    name: "output",
    label: "Output",
    description,
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
          details: undefined,
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
};
