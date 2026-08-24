// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared JSON Schema validation for agent parameter values.
 *
 * A published export of `@appstrate/core`, so out-of-tree consumers (modules,
 * external tooling) reach the same verdict as the platform on the same
 * `(values, schema)` pair. In this workspace it has two importers:
 * `apps/api/src/services/schema.ts`, which re-exports it alongside the
 * server-only `validateInput` / `validateOutput`, and the CLI's
 * `validateLocalInput` (`apps/cli/src/commands/run.ts`), which gates a
 * local `appstrate run` on the verdict the server would have reached.
 *
 * Owns the process's ONE Ajv2020 instance and the ONE compiled-validator
 * cache in front of it ({@link compileCached}) — built from the shared factory
 * in `./ajv.ts` so the dialect (formats, strict-mode, coercion) matches every
 * caller. `apps/api`'s `validateInput` / `validateOutput` /
 * `validateConnectionCredentials` compile through the same cache rather than
 * standing up a second instance: a second one grows its own unbounded
 * registry, and a schema carrying `$id` compiled once in each throws
 * "schema with key or id … already exists".
 */

import { createAjv } from "./ajv.ts";
import type { JSONSchemaObject } from "./form.ts";

const ajv = createAjv({ coerceTypes: true });

// Compiled-validator cache. The validators in front of it run on hot paths
// (per run, per connect, per input-settings save) and receive schemas freshly
// parsed from JSONB — or rebuilt into a fresh object on every call, as
// `apps/api`'s file-field-stripped `effectiveSchema` is — so AJV's own
// by-reference cache never hits: compilation (the expensive step) ran on every
// call AND each compile was retained forever in the Ajv instance's internal
// registry (unbounded growth in a long-lived process). Key by the schema's
// canonical JSON so structurally-equal schemas share one compiled validator;
// bound the map to cap memory. Shared by every caller, in-tree and out.
const validatorCache = new Map<string, ReturnType<typeof ajv.compile>>();

/** Hard bound on the number of retained compiled validators. */
export const MAX_CACHED_VALIDATORS = 500;

/**
 * Compile `schema` (or reuse the compiled validator for a structurally
 * identical one), never leaving it registered inside the Ajv instance.
 *
 * Exported because `apps/api` validates three more shapes than
 * {@link validateAgainstSchema} covers (input with file fields stripped,
 * output with `additionalProperties` relaxed, connection credentials) and must
 * compile them through THIS cache — see the module doc for what a second Ajv
 * instance costs.
 */
export function compileCached(schema: JSONSchemaObject): ReturnType<typeof ajv.compile> {
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

export interface SchemaValidationResult {
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

export function validateAgainstSchema(
  data: Record<string, unknown>,
  schema: JSONSchemaObject,
): SchemaValidationResult {
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
