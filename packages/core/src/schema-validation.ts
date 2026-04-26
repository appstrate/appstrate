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

// ---------------------------------------------------------------------------
// Per-run config override merge
// ---------------------------------------------------------------------------

/**
 * Recursive merge of two configs. The override wins at every leaf, but
 * plain-object children are merged recursively so siblings the caller
 * did not mention pass through. Arrays are replaced wholesale (treated
 * as atomic values). `null` in the override clears the inherited leaf;
 * `undefined` is skipped.
 *
 * Single source of truth for both the platform run pipeline (when a
 * client passes `config` in the run body to override the persisted
 * `application_packages.config`) and the CLI's local PiRunner path
 * (which merges `--config <json>` over the same persisted state). The
 * shared function guarantees byte-identical resolution of the same
 * `(persisted, override)` pair regardless of who computes the merge —
 * mirrors the OpenAI Assistants `runs.create { instructions, model,
 * tools }` and Argo Workflows `submitOptions.parameters` SOTA, where
 * the merge logic lives once and every client reaches the same answer.
 *
 * Pure: never mutates either argument; always returns a new object.
 */
export function deepMergeConfig(
  base: Record<string, unknown>,
  override: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!override) return { ...base };
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    const baseValue = out[key];
    if (isPlainObject(value) && isPlainObject(baseValue)) {
      out[key] = deepMergeConfig(baseValue, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
