// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared JSON Schema validation for agent parameter values.
 *
 * A published export of `@appstrate/core`, so out-of-tree consumers (modules,
 * external tooling) reach the same verdict as the platform on the same
 * `(values, schema)` pair. In this workspace its sole importer is
 * `apps/api/src/services/schema.ts`, which re-exports it as the server's
 * `validateConfig`.
 *
 * Reuses the shared Ajv2020 factory in `./ajv.ts` so the dialect
 * (formats, strict-mode, coercion) matches between callers.
 */

import { createAjv } from "./ajv.ts";
import type { JSONSchemaObject } from "./form.ts";

const ajv = createAjv({ coerceTypes: true });

// Compiled-validator cache. `validateConfig` runs on hot paths (per run,
// per config save) and receives schemas freshly parsed from JSONB, so
// AJV's own by-reference cache never hits — compilation (the expensive
// step) ran on every call AND each compile was retained forever in the
// Ajv instance's internal registry (unbounded growth in a long-lived
// process). Key by the schema's canonical JSON so structurally-equal
// schemas share one compiled validator; bound the map to cap memory.
// Mirrors `compileCached` in `apps/api/src/services/schema.ts`.
const validatorCache = new Map<string, ReturnType<typeof ajv.compile>>();
const MAX_CACHED_VALIDATORS = 500;

function compileCached(schema: JSONSchemaObject): ReturnType<typeof ajv.compile> {
  const key = JSON.stringify(schema);
  let validate = validatorCache.get(key);
  if (!validate) {
    try {
      validate = ajv.compile(schema);
    } catch (err) {
      // Surface a clear, typed error instead of leaking AJV's raw throw
      // (which can be a bare string or a low-level "schema is invalid"
      // object) to callers on hot paths.
      throw new Error(
        `Failed to compile config JSON schema: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      // `ajv.compile` registers the schema object (and its `$id`, when
      // present) in the instance's internal reference-keyed registry.
      // Because every schema arrives as a fresh object, that registry
      // would (a) retain each compiled schema forever and (b) throw
      // "schema with key or id ... already exists" the next time a
      // *different* object carrying the same `$id` is compiled. Evict
      // immediately — the returned validate closure is self-contained.
      ajv.removeSchema(schema);
    }
    if (validatorCache.size >= MAX_CACHED_VALIDATORS) {
      // Simple FIFO eviction: Map preserves insertion order.
      const oldest = validatorCache.keys().next().value;
      if (oldest !== undefined) validatorCache.delete(oldest);
    }
    validatorCache.set(key, validate);
  }
  return validate;
}

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
export function stripEmptyRequired(
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
  // Empty-schema short-circuit — an agent that declares no properties
  // accepts anything.
  if (!schema.properties || Object.keys(schema.properties).length === 0) {
    return { valid: true, errors: [], data };
  }
  const effectiveData = stripEmptyRequired(data, schema.required ?? []);
  const validate = compileCached(schema);
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
