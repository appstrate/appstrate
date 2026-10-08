// SPDX-License-Identifier: Apache-2.0

/**
 * Reading an integration's `variables.schema` (AFPS §7.12) — the connection
 * variables the hosted connect form asks for before any credential or OAuth
 * step. Pure functions over the `GET /connect/context` payload, kept apart from
 * the component for the same reasons as `credential-schema.ts`.
 */

import type { paths } from "../../api/client";

/** The `variables` member of the connect context: the schema and the values to prefill. */
export type ConnectContextVariables = NonNullable<
  paths["/api/integrations/connect/context"]["get"]["responses"][200]["content"]["application/json"]["variables"]
>;

/** One declared variable, as the form presents it. */
export interface VariableField {
  name: string;
  title?: string;
  description?: string;
  /** Example shown in an empty input: the first `examples` entry, else the `default`. */
  placeholder?: string;
  format?: string;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** The declared variables, in declaration order. */
export function variableFields(schema: Record<string, unknown>): VariableField[] {
  const props = schema.properties;
  if (!props || typeof props !== "object") return [];
  return Object.entries(props as Record<string, unknown>).map(([name, raw]) => {
    const prop = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const example = Array.isArray(prop.examples) ? str(prop.examples[0]) : undefined;
    return {
      name,
      title: str(prop.title),
      description: str(prop.description),
      placeholder: example ?? str(prop.default),
      format: str(prop.format),
    };
  });
}

/**
 * Seed values for the form: the reconnected connection's value, else the
 * declared `default`. Only declared variables are seeded, so a value the
 * manifest no longer declares is never resubmitted.
 */
export function initialVariableValues(
  variables: ConnectContextVariables | null | undefined,
): Record<string, string> {
  if (!variables) return {};
  const declared = variables.schema.properties as Record<string, { default?: unknown }> | undefined;
  const out: Record<string, string> = {};
  for (const { name } of variableFields(variables.schema)) {
    const seed = str(variables.values[name]) ?? str(declared?.[name]?.default);
    if (seed !== undefined) out[name] = seed;
  }
  return out;
}
