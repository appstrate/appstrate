// SPDX-License-Identifier: Apache-2.0

import { isFileField, type JSONSchemaObject, type JSONSchema7 } from "@appstrate/core/form";
import {
  compileCached,
  isUnconstrainedSchema,
  stripEmptyRequired,
  validateAgainstSchema as validateAgainstSchemaCore,
  type SchemaValidationResult,
} from "@appstrate/core/schema-validation";

// --- AJV runtime validation ---
//
// The Ajv2020 instance, its dialect and the compiled-validator cache in front
// of it all live in `@appstrate/core/schema-validation` — one instance for the
// process, so nothing here can grow a second unbounded schema registry or
// collide with the shared one over a `$id`. `validateAgainstSchema` is
// re-exported below from the same module, a published core export so
// out-of-tree consumers apply the same gate. What stays HERE is the three
// server-only shapes: input with file fields stripped, output with
// `additionalProperties` relaxed, and connection credentials.

// --- Section C: Validation functions ---

type ValidationResult = SchemaValidationResult;

/**
 * Shared AJV validation path for input/output.
 *
 * Differences between the two kinds, encoded here:
 * - "input":   filters out file fields (already resolved from upload:// URIs before this runs),
 *              normalizes empty strings for remaining required fields. Accepts undefined input.
 * - "output":  relaxes `additionalProperties: true` (extra fields like state/tokenUsage allowed),
 *              skips normalization, returns errors as pre-formatted strings.
 *
 * Bare-schema validation lives in `@appstrate/core/schema-validation`,
 * published for out-of-tree consumers; this module re-exports it below so all
 * three validators share one import surface.
 */
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
  kind: "input" | "output",
  data: Record<string, unknown> | undefined,
  schema: JSONSchemaObject,
): ValidationResult | { valid: boolean; errors: string[] } {
  // 1. Empty-schema short circuit — `isUnconstrainedSchema` (core), not a
  //    local `properties` test: a schema constrains plenty without naming a
  //    property (`required`, `additionalProperties`, `allOf`, `$ref`), and all
  //    of those used to be waved through here before AJV ran.
  if (isUnconstrainedSchema(schema)) {
    if (kind === "output") return { valid: true, errors: [] };
    return {
      valid: true,
      errors: [],
      data: data ?? {},
    };
  }

  // 2. Per-kind schema + data preparation
  let effectiveSchema: JSONSchemaObject;
  let effectiveData: Record<string, unknown> = data ?? {};

  if (kind === "input") {
    // Exclude file fields from AJV validation. File inputs are resolved from
    // `upload://upl_xxx` URIs by the input parser BEFORE this runs; the
    // declared schema still uses `format: uri` + `contentMediaType` which
    // does not match the `upload:` URI scheme under strict format checks.
    //
    // The exclusion RELAXES each file property to `{}` instead of deleting the
    // key, and the effective schema is a SPREAD of the author's schema rather
    // than a fresh `{type, properties, required}` object. Both details matter:
    //
    //  - rebuilding three keys silently discarded every other keyword the
    //    author declared — `additionalProperties`, `patternProperties`,
    //    `allOf`/`oneOf`, `dependentRequired`, `minProperties`, `$defs`/`$ref`
    //    — so an input the declared schema forbids was accepted;
    //  - deleting the key would break the keywords that reason about the
    //    property SET. The parser leaves the resolved `appfile://…` value in
    //    `input` (see `assertInputValid` in `services/input-parser.ts`), so
    //    under a declared `additionalProperties: false` an undeclared file key
    //    would now be rejected as an unexpected extra.
    //
    // A required file field is still dropped from `required`, exactly as
    // before: whether a file was supplied is the upload pipeline's question,
    // not AJV's.
    const relaxedProps: Record<string, JSONSchema7> = {};
    const fileFields = new Set<string>();
    for (const [key, prop] of Object.entries(schema.properties ?? {})) {
      if (isFileField(prop)) {
        fileFields.add(key);
        relaxedProps[key] = {};
      } else {
        relaxedProps[key] = prop;
      }
    }
    const nonFileRequired = schema.required?.filter((k) => !fileFields.has(k)) ?? [];
    effectiveSchema = { ...schema, properties: relaxedProps };
    if (nonFileRequired.length > 0) effectiveSchema.required = nonFileRequired;
    else delete effectiveSchema.required;
    effectiveData = stripEmptyRequired(effectiveData, nonFileRequired);
  } else {
    // output: allow extra fields (state, tokenUsage, etc.)
    effectiveSchema = { ...schema, additionalProperties: true } as JSONSchemaObject & {
      additionalProperties: boolean;
    };
  }

  // 3. Compile (cached) + validate
  //
  // Drop the author's `$schema` first. The shared instance is an Ajv2020 bound
  // to one dialect, so a manifest declaring a different one — draft-07, which
  // most JSON Schema tooling still emits — makes `ajv.compile` THROW
  // ("no schema with key or ref …/draft-07/schema") instead of returning a
  // validator: a 500 where the whole contract of this function is a 400 with
  // per-field errors. The input branch above is a SPREAD of the author's
  // schema, so it forwards the key (the old rebuild-three-keys version dropped
  // it by accident); the output branch always forwarded it. `$schema` declares
  // the document's dialect, it asserts nothing about the value, so removing it
  // cannot change a verdict for any keyword these manifests use.
  const { $schema: _declaredDialect, ...dialectFreeSchema } =
    effectiveSchema as JSONSchemaObject & {
      $schema?: unknown;
    };
  const validate = compileCached(dialectFreeSchema as JSONSchemaObject);
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

// Re-export the shared schema validator so the three validators share one
// import surface.
export const validateAgainstSchema = validateAgainstSchemaCore;

/**
 * Validate a submitted credential bag against an integration auth's
 * `credentials.schema` (AFPS §4.1.3).
 *
 * Beyond catching missing required fields, this catches wrong-cased or
 * misspelled keys (e.g. `apiKey` when the manifest declares `api_key`):
 * the manifest schema names the exact field keys, so an unexpected key
 * leaves the required field absent and fails validation. Without this gate
 * such a bag persists a healthy-looking connection whose `delivery.http`
 * injection silently resolves to an empty value at runtime (the credential
 * header is never injected, yet the run still "succeeds").
 *
 * No-op when the auth declares a schema that constrains nothing — there is
 * nothing to validate against, and forcing field shape on an undeclared schema
 * would reject legitimately loose `custom` auths.
 */
export function validateConnectionCredentials(
  schema: JSONSchemaObject | undefined,
  // Credential values can be any JSON type per JSON Schema 2020-12 §7.5 —
  // numbers, booleans, objects, arrays, not just strings. The AJV validator
  // honours the manifest schema's `type` declarations regardless.
  credentials: Record<string, unknown>,
): ValidationResult {
  // Same narrowed predicate as the input/output path: an auth that declares
  // nothing is legitimately loose, but one that declares `required` (or any
  // other assertion) without naming a property is NOT — and that used to pass.
  if (!schema || isUnconstrainedSchema(schema)) {
    return { valid: true, errors: [], data: credentials };
  }
  const required = Array.isArray(schema.required) ? schema.required : [];
  // Mirror the input path: AJV coerceTypes lets "" satisfy `required`, so
  // strip empty/null values for required keys before validating.
  const effectiveData = stripEmptyRequired(credentials, required);
  const validate = compileCached(schema);
  if (validate(effectiveData)) return { valid: true, errors: [], data: credentials };
  const errors = (validate.errors || []).map((e) => ({
    field:
      e.instancePath.replace(/^\//, "") ||
      (e.params as { missingProperty?: string })?.missingProperty ||
      "unknown",
    message: e.message || "Validation failed",
  }));
  return { valid: false, errors };
}

export function validateInput(
  input: Record<string, unknown> | undefined,
  schema: JSONSchemaObject,
): ValidationResult {
  return runValidate("input", input, schema);
}

export function validateOutput(
  result: Record<string, unknown>,
  schema: JSONSchemaObject,
): { valid: boolean; errors: string[] } {
  return runValidate("output", result, schema);
}
