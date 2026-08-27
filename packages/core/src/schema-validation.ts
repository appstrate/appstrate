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
 *
 * Two levels, deliberately different about failure:
 * {@link compileCached} is the compile funnel and THROWS on a schema Ajv
 * cannot compile — the callers that want that (`runtime-tool-defs`'s
 * `buildOutputDef`, which records the compile error, and `apps/api`'s three
 * server-only validators) call it directly. {@link validateAgainstSchema} is a
 * VALIDATOR and never throws: an uncompilable schema comes back as
 * `valid: false` carrying the compiler's message. See its docstring for why.
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
  // Drop the author's root `$schema` before anything else — including before
  // the cache key, so a draft-07 document and its dialect-free twin share one
  // compiled validator.
  //
  // This instance is an Ajv2020 bound to ONE dialect, so a schema declaring a
  // different one makes `ajv.compile` THROW ("no schema with key or ref
  // …/draft-07/schema") instead of returning a validator — for draft-04,
  // draft-06, draft-07, 2019-09 and any vendor URL alike. draft-07 is what
  // most JSON Schema tooling still emits, so that throw fires on ordinary
  // manifests. `$schema` declares the document's dialect and asserts nothing
  // about the value, so removing it cannot change a verdict for any keyword
  // these manifests use.
  //
  // Stripped HERE rather than in each caller because every compile in the
  // process funnels through this function: the CLI's `validateAgainstSchema`,
  // `apps/api`'s `validateInput` / `validateOutput` /
  // `validateConnectionCredentials`, and the in-container `output`-tool
  // validator all inherit the same answer. A per-caller strip is exactly the
  // drift this module exists to end — `apps/api/src/services/schema.ts` had
  // one and this file did not, so the server accepted a draft-07 manifest the
  // CLI blew up on.
  const compilable = withoutDialect(schema);
  const key = JSON.stringify(compilable);
  let validate = validatorCache.get(key);
  if (!validate) {
    try {
      validate = ajv.compile(compilable);
    } catch (err) {
      // Surface a clear, typed error instead of leaking AJV's raw throw
      // (which can be a bare string or a low-level "schema is invalid"
      // object) to callers on hot paths.
      throw new Error(
        `Failed to compile config JSON schema: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    } finally {
      // `ajv.compile` registers the schema object (and its `$id`, when
      // present) in the instance's internal reference-keyed registry.
      // Because every schema arrives as a fresh object, that registry
      // would (a) retain each compiled schema forever and (b) throw
      // "schema with key or id ... already exists" the next time a
      // *different* object carrying the same `$id` is compiled. Evict
      // immediately — the returned validate closure is self-contained. Evict
      // the object actually handed to `compile`, not the caller's.
      ajv.removeSchema(compilable);
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

/**
 * `schema` without its root `$schema` dialect declaration, or `schema` itself
 * when it carries none (the common case — no allocation on the hot path).
 *
 * Root only, matching what a JSON Schema resource root means: a nested
 * `$schema` is legal solely at an `$id` boundary, and rewriting subschemas
 * would change the document rather than its dialect label.
 */
function withoutDialect(schema: JSONSchemaObject): JSONSchemaObject {
  if (!("$schema" in schema)) return schema;
  const { $schema: _declaredDialect, ...rest } = schema as JSONSchemaObject & {
    $schema?: unknown;
  };
  return rest as JSONSchemaObject;
}

export interface SchemaValidationResult {
  valid: boolean;
  errors: { field: string; message: string }[];
  data?: Record<string, unknown>;
}

/**
 * The keywords a schema may carry and still constrain NOTHING about the value.
 *
 * `type` is on the list because every caller of this predicate has already
 * narrowed its value to a plain object; `properties` is handled separately
 * below (it is non-constraining only when empty). Everything else here is a
 * pure annotation — Ajv attaches no assertion to it.
 *
 * Deliberately minimal: a keyword missing from this list only means the
 * validator runs, and running the validator is always the correct answer. A
 * keyword wrongly ON the list means a constraint is skipped, which is the bug
 * this predicate exists to end.
 */
const NON_CONSTRAINING_KEYWORDS: ReadonlySet<string> = new Set([
  "type",
  "title",
  "description",
  "$schema",
  "$comment",
]);

/**
 * True when `schema` cannot reject any object — the "this agent declares no
 * input, so anything goes" case that every validator here short-circuits on.
 *
 * The test used to be `!schema.properties || properties is empty`, which is a
 * different (and much broader) question: `properties` says what a NAMED key
 * must look like, and a schema constrains plenty without naming one.
 * `{properties: {}, required: ["x"]}`, `{properties: {}, additionalProperties:
 * false}` and `{allOf: [{required: ["a"]}]}` were all short-circuited to
 * `valid: true` before Ajv ever ran — and `createAjv` uses `strict: false`, so
 * Ajv would have enforced every one of them.
 *
 * Exported (rather than repeated) because three validators ask this exact
 * question — {@link validateAgainstSchema} here, plus `validateInput` /
 * `validateOutput` and `validateConnectionCredentials` in
 * `apps/api/src/services/schema.ts` — and the copies are what drifted.
 */
export function isUnconstrainedSchema(schema: JSONSchemaObject): boolean {
  // Runtime shape, not the declared one: schemas reach here through
  // `asJSONSchemaObject` (an unchecked cast over JSONB / manifest data), so
  // `properties` may be absent and keywords outside the interface — `allOf`,
  // `additionalProperties`, `$ref` — may be present.
  const keywords = schema as unknown as Record<string, unknown>;
  for (const key of Object.keys(keywords)) {
    if (NON_CONSTRAINING_KEYWORDS.has(key)) continue;
    if (key === "properties") {
      const props = keywords.properties;
      if (props && typeof props === "object" && Object.keys(props).length > 0) return false;
      continue;
    }
    return false;
  }
  return true;
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

/**
 * Validate `data` against `schema` and return the verdict.
 *
 * **Contract: this function does not throw.** Every outcome — including "your
 * schema is broken" — comes back as a {@link SchemaValidationResult}. A caller
 * that wants the compile failure as an exception calls {@link compileCached}
 * directly; that is the explicit opt-in, and `runtime-tool-defs.ts` uses it.
 *
 * The contract is not decoration, it is what the two callers are written
 * against. `apps/cli`'s `validateLocalInput` renders `result.errors` and exits
 * 1; `apps/api`'s `PUT …/input-settings` maps them to a 400 `validationFailed`.
 * An exception on either path is a stack trace / a 500 where the whole point of
 * the call is a per-field rejection — the same reasoning that put a `$schema`
 * strip in `apps/api/src/services/schema.ts`, which this module now owns for
 * every caller (see {@link compileCached}).
 *
 * A schema Ajv refuses to compile therefore yields `valid: false` with the
 * compiler's message on an empty `field` (the two callers already render an
 * unattributed error: the CLI prints it, the route maps it to `values`). NOT
 * `valid: true`: an uncompilable schema has checked nothing, and reporting
 * "accepted" for a value nothing examined is the one failure mode worse than a
 * throw. It is also not a behaviour a working agent can be relying on — the
 * platform's own `validateInput` compiles the same schema on every launch, so
 * an agent whose input schema cannot compile already fails every run.
 */
export function validateAgainstSchema(
  data: Record<string, unknown>,
  schema: JSONSchemaObject,
): SchemaValidationResult {
  // Empty-schema short-circuit — an agent that declares nothing accepts
  // anything. Kept (rather than always compiling) because it is the common
  // case and it echoes `data` back untouched; narrowed to
  // {@link isUnconstrainedSchema} so it can no longer swallow a constraint.
  if (isUnconstrainedSchema(schema)) {
    return { valid: true, errors: [], data };
  }
  const effectiveData = stripEmptyRequired(data, schema.required ?? []);
  let validate: ReturnType<typeof ajv.compile>;
  try {
    validate = compileCached(schema);
  } catch (err) {
    // `{"allOf":[]}`, `{"enum":[]}`, `{"nullable":true}` without a `type`, a
    // `$ref` pointing at nothing: shapes that reach Ajv's own meta-schema
    // check or its reference resolver and fail there. Narrowing
    // `isUnconstrainedSchema` to stop waiving `required` / `allOf` /
    // `additionalProperties` (the right fix, kept) routed all of them into
    // the compiler for the first time, turning a verdict into an exception.
    return {
      valid: false,
      errors: [{ field: "", message: err instanceof Error ? err.message : String(err) }],
    };
  }
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
