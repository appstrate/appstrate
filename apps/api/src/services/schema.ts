// SPDX-License-Identifier: Apache-2.0

import Ajv2020 from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";

// ajv-formats ships a CJS default-export under an ESM wrapper; the named
// type exposed by @types/ajv-formats expects AJV's Ajv (draft-07) class.
// We use the 2020-12 vocabulary here so we cast through `unknown` — the
// runtime shape is a function(Ajv instance), which matches either draft.
const addFormats = addFormatsImport as unknown as (ajv: Ajv2020) => Ajv2020;
import { isFileField, type JSONSchemaObject, type JSONSchema7 } from "@appstrate/core/form";
import { scopedNameRegex } from "@appstrate/core/validation";
import { normalizeConfigForValidation } from "../lib/agent-readiness-utils.ts";

// --- AJV runtime validation ---

const ajv = new Ajv2020({ coerceTypes: true, allErrors: true, strict: false });
addFormats(ajv);

// --- Section C: Validation functions ---

export interface ValidationResult {
  valid: boolean;
  errors: { field: string; message: string }[];
  data?: Record<string, unknown>;
}

/**
 * Shared AJV validation path for config/input/output.
 *
 * Differences between the three kinds, encoded here:
 * - "config":  validates the raw schema, normalizes empty strings as missing for required fields.
 * - "input":   filters out file fields (already resolved from upload:// URIs before this runs),
 *              normalizes empty strings for remaining required fields. Accepts undefined input.
 * - "output":  relaxes `additionalProperties: true` (extra fields like state/tokenUsage allowed),
 *              skips normalization, returns errors as pre-formatted strings.
 */
function runValidate(
  kind: "config",
  data: Record<string, unknown>,
  schema: JSONSchemaObject,
): ValidationResult;
function runValidate(
  kind: "input",
  data: Record<string, unknown> | undefined,
  schema: JSONSchemaObject,
): ValidationResult;
function runValidate(
  kind: "output",
  data: Record<string, unknown>,
  schema: JSONSchemaObject,
): { valid: boolean; errors: string[] };
function runValidate(
  kind: "config" | "input" | "output",
  data: Record<string, unknown> | undefined,
  schema: JSONSchemaObject,
): ValidationResult | { valid: boolean; errors: string[] } {
  // 1. Empty-schema short circuit
  if (!schema.properties || Object.keys(schema.properties).length === 0) {
    if (kind === "output") return { valid: true, errors: [] };
    return {
      valid: true,
      errors: [],
      data: kind === "input" ? (data ?? {}) : data,
    };
  }

  // 2. Per-kind schema + data preparation
  let effectiveSchema: JSONSchemaObject = schema;
  let effectiveData: Record<string, unknown> = data ?? {};

  if (kind === "config") {
    // Treat empty strings as missing for required fields (aligned with frontend validation)
    effectiveData = normalizeConfigForValidation(effectiveData, schema.required ?? []);
  } else if (kind === "input") {
    // Exclude file fields from AJV validation. File inputs are resolved from
    // `upload://upl_xxx` URIs by the input parser BEFORE this runs; the
    // declared schema still uses `format: uri` + `contentMediaType` which
    // does not match the `upload:` URI scheme under strict format checks.
    const nonFileProps: Record<string, JSONSchema7> = {};
    for (const [key, prop] of Object.entries(schema.properties)) {
      if (!isFileField(prop)) nonFileProps[key] = prop;
    }
    if (Object.keys(nonFileProps).length === 0) {
      return { valid: true, errors: [], data: effectiveData };
    }
    const nonFileRequired = schema.required?.filter((k) => nonFileProps[k]) ?? [];
    effectiveSchema = {
      type: "object",
      properties: nonFileProps,
      ...(nonFileRequired.length > 0 ? { required: nonFileRequired } : {}),
    };
    effectiveData = normalizeConfigForValidation(effectiveData, nonFileRequired);
  } else {
    // output: allow extra fields (state, tokenUsage, etc.)
    effectiveSchema = { ...schema, additionalProperties: true } as JSONSchemaObject & {
      additionalProperties: boolean;
    };
  }

  // 3. Compile + validate
  const validate = ajv.compile(effectiveSchema);
  const valid = validate(effectiveData);

  // 4. Per-kind error mapping
  if (kind === "output") {
    if (valid) return { valid: true, errors: [] };
    const errors = (validate.errors || []).map(
      (e) =>
        `Field '${e.instancePath.replace(/^\//, "") || (e.params as { missingProperty?: string })?.missingProperty || "unknown"}': ${e.message || "Validation failed"}`,
    );
    return { valid: false, errors };
  }

  if (valid) return { valid: true, errors: [], data: effectiveData };
  const errors = (validate.errors || []).map((e) => ({
    field:
      e.instancePath.replace(/^\//, "") ||
      (e.params as { missingProperty?: string })?.missingProperty ||
      "unknown",
    message: e.message || "Validation failed",
  }));
  return { valid: false, errors };
}

export function validateConfig(
  data: Record<string, unknown>,
  schema: JSONSchemaObject,
): ValidationResult {
  return runValidate("config", data, schema);
}

export function validateInput(
  input: Record<string, unknown> | undefined,
  schema: JSONSchemaObject,
): ValidationResult {
  return runValidate("input", input, schema);
}

/** Check if a schema has any file fields (format: "uri" + contentMediaType). */
export function schemaHasFileFields(schema?: JSONSchemaObject): boolean {
  if (!schema?.properties) return false;
  return Object.values(schema.properties).some(isFileField);
}

export function validateOutput(
  result: Record<string, unknown>,
  schema: JSONSchemaObject,
): { valid: boolean; errors: string[] } {
  return runValidate("output", result, schema);
}

export function validateAgentContent(
  prompt: string,
  skills: { id: string; name?: string; description: string; content: string }[],
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!prompt || prompt.trim().length === 0) {
    errors.push("prompt cannot be empty");
  }
  const seenIds = new Set<string>();
  for (const skill of skills) {
    if (!scopedNameRegex.test(skill.id)) {
      errors.push(`skill.id '${skill.id}' is not a valid package reference`);
    }
    if (seenIds.has(skill.id)) {
      errors.push(`skill.id '${skill.id}' is duplicated`);
    }
    seenIds.add(skill.id);
  }
  return { valid: errors.length === 0, errors };
}
