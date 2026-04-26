// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared agent-config schema validation.
 *
 * Centralised so the API run pipeline (server-side execution path) and
 * the CLI's `appstrate run` (local PiRunner path) reach the same
 * verdict on the same `(config, schema)` pair. Without this, an agent
 * that the dashboard rejects on save could still launch from the CLI
 * with garbage config — and vice versa.
 *
 * Reuses the shared Ajv2020 factory in `./ajv.ts` so the dialect
 * (formats, strict-mode, coercion) matches between callers.
 */

import { createAjv } from "./ajv.ts";
import type { JSONSchemaObject } from "./form.ts";

const ajv = createAjv({ coerceTypes: true });

export interface ConfigValidationResult {
  valid: boolean;
  errors: { field: string; message: string }[];
  data?: Record<string, unknown>;
}

/**
 * AJV with `coerceTypes: true` coerces `null → ""` for string-typed
 * properties, which incorrectly satisfies a `required` check. Strip
 * empty-string and null values for required keys so AJV sees them as
 * missing and reports them as such.
 */
function stripEmptyRequired(
  data: Record<string, unknown>,
  required: string[],
): Record<string, unknown> {
  const cleaned = { ...data };
  for (const key of required) {
    if (cleaned[key] === "" || cleaned[key] === null) delete cleaned[key];
  }
  return cleaned;
}

export function validateConfig(
  data: Record<string, unknown>,
  schema: JSONSchemaObject,
): ConfigValidationResult {
  // Empty-schema short-circuit — agents without a config schema accept
  // anything.
  if (!schema.properties || Object.keys(schema.properties).length === 0) {
    return { valid: true, errors: [], data };
  }
  const effectiveData = stripEmptyRequired(data, schema.required ?? []);
  const validate = ajv.compile(schema);
  const valid = validate(effectiveData);
  if (valid) return { valid: true, errors: [], data: effectiveData };
  const errors = (validate.errors ?? []).map((e) => ({
    field:
      e.instancePath.replace(/^\//, "") ||
      (e.params as { missingProperty?: string })?.missingProperty ||
      "unknown",
    message: e.message ?? "Validation failed",
  }));
  return { valid: false, errors };
}
