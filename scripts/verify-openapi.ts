// SPDX-License-Identifier: Apache-2.0

/**
 * Verify OpenAPI spec: completeness, structural validity, best practices,
 * and Zod ↔ OpenAPI request-body schema consistency.
 *
 * 1. Endpoint index — enumerates the spec's "VERB /path" set for sections 5 and 5b
 * 2. Structural validation — @readme/openapi-parser (OpenAPI 3.1 schema conformance)
 * 3. Best practices lint — @redocly/openapi-core (recommended ruleset)
 * 4. Zod ↔ OpenAPI schema comparison — compares Zod-derived JSON Schemas (pre-converted
 *    in the registry via z.toJSONSchema()) against hand-written OpenAPI requestBody schemas
 * 4b. Step 4 coverage — every endpoint whose spec declares an application/json request body
 *    must be registered (core registry or a module's openApiSchemas()) or listed in
 *    EXEMPT_REQUEST_BODIES with a stated reason; a stale exemption fails too
 * 5. Code subset Spec — statically enumerates router.METHOD() and app.METHOD() calls across
 *    apps/api/src/routes (per-domain route files) plus apps/api/src/modules (built-in modules)
 *    plus apps/api/src/index.ts, composes the mount prefix from app.route(prefix, factory) calls,
 *    normalises Hono path syntax, and asserts every code-registered endpoint is documented in
 *    the OpenAPI spec or in the explicit allowlist.
 * 5b. Spec subset Code — the mirror of 5: every documented endpoint must be registered by
 *    some router, or listed in SPEC_ONLY_ALLOWLIST. Replaces the hand-typed 242-entry
 *    `expectedEndpoints` array, whose only unique signal this was.
 * 6. Response schema presence — every 2xx JSON response (except 204) must declare a schema
 * 7. Shared-type ↔ OpenAPI response required-field comparison — for each registered
 *    (spec-schema ↔ @appstrate/shared-types interface) pair, asserts the two agree on which
 *    fields are guaranteed, in BOTH directions: every type-required field is required in the
 *    spec (spec-optional / type-required drift), and every spec-required field the type
 *    declares with `?` is reported too (spec-required / type-optional drift). Accepted
 *    divergences live in KNOWN_DRIFT and KNOWN_REVERSE_DRIFT respectively.
 *
 * Module-owned paths and schemas are loaded dynamically from built-in modules.
 * The set of modules validated matches `MODULES` (default: all built-in).
 *
 * Usage: bun scripts/verify-openapi.ts
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { validate as validateOpenAPI } from "@readme/openapi-parser";
import { lintFromString, createConfig } from "@redocly/openapi-core";
import type { OpenApiSchemaEntry } from "@appstrate/core/module";
import { buildOpenApiSpec } from "../apps/api/src/openapi/index.ts";
import {
  buildZodSchemaRegistry,
  EXEMPT_REQUEST_BODIES,
} from "../apps/api/src/openapi/zod-schema-registry.ts";
import {
  responseTypeRegistry,
  KNOWN_DRIFT,
  KNOWN_REVERSE_DRIFT,
  EXEMPT_SCHEMAS,
} from "../apps/api/src/openapi/response-type-registry.ts";
// Relative, like every other cross-workspace import in this file: the root
// manifest declares no `@appstrate/runner-pi` dependency, and this gate only
// needs the one path table.
import {
  LLM_PROXY_ROUTES,
  llmProxyUrlPath,
  type ProxiedApiShape,
} from "../packages/runner-pi/src/llm-proxy-routes.ts";
import { collectModuleOpenApi, discoverWorkspaceModuleDirs } from "./lib/module-openapi.ts";
import { getTypeShape, type TypeShape } from "./lib/ts-interface-required-keys.ts";

// ---------------------------------------------------------------------------
// Auto-discover built-in modules and collect their OpenAPI contributions
// ---------------------------------------------------------------------------
//
// Discovery scans `apps/api/src/modules/*/index.ts` — no hardcoded list.
// External modules (npm-published) are not validated here; they're
// loaded at runtime via MODULES and can't be imported without full boot.

const {
  paths: modulePaths,
  componentSchemas: moduleComponentSchemas,
  tags: moduleTags,
  schemas: moduleSchemas,
} = await collectModuleOpenApi();

// Build the full spec and registry with module contributions
const openApiSpec = buildOpenApiSpec(modulePaths, moduleComponentSchemas, moduleTags);
const zodSchemaRegistry = buildZodSchemaRegistry(moduleSchemas);

let exitCode = 0;

// ═══════════════════════════════════════════════════
// 1. Endpoint index
// ═══════════════════════════════════════════════════
//
// Builds the "VERB /path" set the later sections compare against.
//
// This section used to also assert that set, bidirectionally, against a
// hand-typed `expectedEndpoints` array of 242 string literals. That array is
// gone: every signal it carried is now produced by something that derives the
// answer instead of restating it.
//   - "registered in code but undocumented" → §5 (Code ⊆ Spec).
//   - "documented but registered by no router" → §5b (Spec ⊆ Code), which is
//     the one signal the list held alone and the reason it survived this long.
//   - "endpoint dropped from the published contract" → `Endpoint removed` in
//     scripts/detect-breaking-changes.ts, against the committed baseline.
// Module-contributed endpoints were already exempt — they were pushed into
// `expectedEndpoints` straight from each module's `openApiPaths()` output, on
// the stated grounds that "adding or removing a module endpoint requires no
// update here". Core was the half that never got that treatment, so every new
// core route cost a second edit in this file whose only failure mode was
// forgetting to make it.

const specEndpoints = new Set<string>();
const paths = openApiSpec.paths as Record<string, Record<string, unknown>>;
for (const [path, methods] of Object.entries(paths)) {
  for (const method of Object.keys(methods)) {
    specEndpoints.add(`${method.toUpperCase()} ${path}`);
  }
}

console.log(`\n  1. Endpoint Index`);
console.log(`  -------------------`);
console.log(`  Spec endpoints: ${specEndpoints.size} (coverage asserted in §5 / §5b)`);

// ═══════════════════════════════════════════════════
// 2. Structural validation (@readme/openapi-parser)
// ═══════════════════════════════════════════════════

console.log(`\n  2. Structural Validation (@readme/openapi-parser)`);
console.log(`  --------------------------------------------------`);

try {
  // Deep-clone to avoid mutation by the parser (it dereferences $refs in-place)
  const specCopy = JSON.parse(JSON.stringify(openApiSpec));
  // Skip external $ref resolution (AFPS schema URLs) — validated separately by afps-spec repo
  await validateOpenAPI(specCopy, { resolve: { external: false } });
  console.log(`  OK — valid OpenAPI ${openApiSpec.openapi} document.`);
} catch (err: unknown) {
  exitCode = 1;
  const msg = err instanceof Error ? err.message : String(err);
  console.log(`  FAIL — ${msg}`);
}

// ═══════════════════════════════════════════════════
// 3. Best practices lint (@redocly/openapi-core)
// ═══════════════════════════════════════════════════

console.log(`\n  3. Best Practices Lint (@redocly/openapi-core)`);
console.log(`  -----------------------------------------------`);

try {
  const config = await createConfig({
    extends: ["recommended"],
    rules: {
      // Hono resolves by registration order — these paths are unambiguous at runtime
      "no-ambiguous-paths": "off",
      // Public endpoints (health, OAuth callback, OpenAPI spec, docs) intentionally
      // have no 4xx responses — they are unauthenticated and always succeed or 5xx
      "operation-4xx-response": "off",
    },
  });

  // Strip remote $refs (AFPS schema URLs) before linting — Redocly's lintFromString
  // has no option equivalent to validateOpenAPI's `resolve: { external: false }`, and
  // fetching the 4 AFPS schemas over HTTPS adds ~20s with no disk cache. The AFPS
  // schemas are validated separately by the afps-spec repo, so replacing them with a
  // stub object is safe and drops this step from ~20s to ~150ms.
  const strippedSpec = JSON.parse(JSON.stringify(openApiSpec), (_key, value) => {
    if (
      value &&
      typeof value === "object" &&
      typeof (value as { $ref?: unknown }).$ref === "string" &&
      /^https?:\/\//.test((value as { $ref: string }).$ref)
    ) {
      return { type: "object", description: `external: ${(value as { $ref: string }).$ref}` };
    }
    return value;
  });
  const source = JSON.stringify(strippedSpec, null, 2);
  const rawProblems = await lintFromString({ source, config });

  // Allow-list: individual (ruleId, pointer) pairs that are intentional
  // deviations from best practice. Prefer keeping rules globally ON and
  // listing narrow exceptions here so any NEW violation still surfaces.
  // Format: `${ruleId}@${pointer}`.
  const LINT_ALLOWLIST = new Set<string>([
    // OIDC device-flow entry form follows Post-Redirect-Get: happy path
    // is 303 to `GET /activate?user_code=...`, error paths re-render HTML
    // with 400/403. Redocly's `operation-2xx-response` rule doesn't
    // treat 3xx as success, but a 2xx here would be a lie — the endpoint
    // never returns content directly. This exception is intentional and
    // scoped to POST /activate only; all other routes must still have a
    // 2xx response.
    "operation-2xx-response@#/paths/~1activate/post/responses",
    // GET /api/mcp/o/{org} is the GET channel of the per-organization MCP
    // Streamable HTTP transport. This server runs stateless (no
    // server-initiated SSE stream), so GET only ever returns 405 — a 2xx
    // would be a lie. Documenting the 405 behaviour is still useful for
    // clients. Scoped to GET /api/mcp/o/{org} only.
    "operation-2xx-response@#/paths/~1api~1mcp~1o~1{org}/get/responses",
  ]);
  const problems = rawProblems.filter((p) => {
    const pointer = p.location?.[0]?.pointer ?? "";
    return !LINT_ALLOWLIST.has(`${p.ruleId}@${pointer}`);
  });

  const errors = problems.filter((p) => p.severity === "error");
  const warnings = problems.filter((p) => p.severity === "warn");

  if (errors.length === 0 && warnings.length === 0) {
    console.log(`  OK — no lint issues.`);
  } else {
    if (errors.length > 0) exitCode = 1;

    console.log(`  ${errors.length} error(s), ${warnings.length} warning(s)\n`);

    for (const p of errors) {
      const loc = p.location?.[0];
      const pointer = loc?.pointer || "";
      console.log(`  ERROR  [${p.ruleId}] ${p.message}${pointer ? ` (at ${pointer})` : ""}`);
    }
    for (const p of warnings) {
      const loc = p.location?.[0];
      const pointer = loc?.pointer || "";
      console.log(`  WARN   [${p.ruleId}] ${p.message}${pointer ? ` (at ${pointer})` : ""}`);
    }
  }
} catch (err: unknown) {
  // A section that throws IS a failed section. Without this the word "FAIL" is
  // printed and the run still ends "ALL CHECKS PASSED" — any throw out of
  // `createConfig` / `lintFromString` (a Redocly bump, a bad rule id, OOM on a
  // 287-path spec) silently disabled the whole best-practice gate. Every other
  // catch in this file sets it; this one was the outlier.
  exitCode = 1;
  const msg = err instanceof Error ? err.message : String(err);
  console.log(`  FAIL — could not lint: ${msg}`);
}

// ═══════════════════════════════════════════════════
// 4. Zod ↔ OpenAPI request body schema comparison
// ═══════════════════════════════════════════════════

console.log(`\n  4. Zod <> OpenAPI Request Body Comparison`);
console.log(`  -------------------------------------------`);

/**
 * Resolve a `$ref` pointer (e.g. "#/components/schemas/Foo") against the spec.
 * Returns the referenced object, or undefined if the path is invalid.
 */
function resolveRef(ref: string): Record<string, unknown> | undefined {
  if (!ref.startsWith("#/")) return undefined;
  const parts = ref.slice(2).split("/");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let current: any = openApiSpec;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = current[part];
  }
  return current as Record<string, unknown> | undefined;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Deref (`$ref`) and merge (`allOf`) a spec schema node into a normalized view
 * for the recursive step-7 comparison. `oneOf`/`anyOf` schemas are treated as
 * open (their required set is ambiguous) so the comparison never false-positives
 * on a polymorphic schema.
 */
function normalizeSpecSchema(
  schema: any,
  depth = 0,
): {
  properties: Record<string, any>;
  required: Set<string>;
  open: boolean; // additionalProperties:true, an open object, or a polymorphic schema
  items?: any;
} | null {
  if (!schema || typeof schema !== "object" || depth > 12) return null;
  let s = schema;
  if (typeof s.$ref === "string") {
    const r = resolveRef(s.$ref);
    if (!r) return null;
    s = r;
  }
  let properties: Record<string, any> = { ...(s.properties ?? {}) };
  const required = new Set<string>(Array.isArray(s.required) ? (s.required as string[]) : []);
  let open = s.additionalProperties === true;
  let items = s.items;
  if (Array.isArray(s.allOf)) {
    for (const sub of s.allOf) {
      const n = normalizeSpecSchema(sub, depth + 1);
      if (!n) continue;
      properties = { ...properties, ...n.properties };
      for (const r of n.required) required.add(r);
      open = open || n.open;
      if (!items && n.items) items = n.items;
    }
  }
  if (Array.isArray(s.oneOf) || Array.isArray(s.anyOf)) open = true;
  // A node declaring no properties is an open/dynamic object (JSON Schema
  // `additionalProperties` defaults to true) — e.g. a bare `{type:"object"}`
  // for a JSONB/JSON-Schema payload. Can't introspect it, so don't descend.
  if (Object.keys(properties).length === 0) open = true;
  return { properties, required, open, items };
}

/** The two accepted-divergence registers, resolved for one registry entry. */
interface DriftExemptions {
  /** `KNOWN_DRIFT` — spec-optional while the type is required. */
  forward: Set<string>;
  /** `KNOWN_REVERSE_DRIFT` — spec-required while the type is optional. */
  reverse: Set<string>;
  /**
   * Which of those labels actually suppressed a finding on this run — the
   * liveness evidence collected below and asserted after the comparison.
   *
   * An exemption that suppresses nothing names nothing: the field was renamed,
   * dropped from the type, or the divergence was fixed — and the entry then
   * silently pre-approves whatever lands at that name tomorrow. Recorded per
   * direction because the two registers are keyed alike and a field can appear
   * in both.
   *
   * "Still needed", not merely "still exists", and that is the opposite call
   * from `GRANDFATHERED` in `scripts/verify-no-migration-dml.ts` — for a
   * reason. That list records a historical fact about an immutable file, so
   * re-deriving it from today's rules would be wrong. These two record a LIVE
   * divergence between a spec and a type that are both edited every week; when
   * the divergence goes, the justification goes with it, and the entry is
   * exactly the stale claim its own doc-comment demands it not become.
   */
  used: { forward: Set<string>; reverse: Set<string> };
}

/**
 * The register label that exempts `field` at `label`, or `null` if none does.
 *
 * An entry may be written as the dotted path or, at the top level only, as the
 * bare field name — both spellings are in use, and the liveness check has to
 * report back the one the author actually wrote.
 */
function exemptionFor(
  register: Set<string>,
  label: string,
  field: string,
  prefix: string,
): string | null {
  if (register.has(label)) return label;
  return !prefix && register.has(field) ? field : null;
}

/**
 * Recursively compare a shared-type {@link TypeShape} against a spec schema,
 * collecting required-field drift in BOTH directions at every nesting level
 * (nested objects and array element types — not just the top level). Recursion
 * descends only where the shared-type exposes a closed nested shape AND the
 * spec side is a closed object; open objects (`additionalProperties:true` /
 * JSONB / Record) short-circuit so dynamic payloads never false-positive.
 */
function compareShapeToSchema(
  shape: TypeShape,
  specSchema: any,
  prefix: string,
  exempt: DriftExemptions,
  issues: string[],
  depth = 0,
): void {
  if (depth > 8) return;
  const norm = normalizeSpecSchema(specSchema);
  if (!norm) return;
  const specProps = new Set(Object.keys(norm.properties));

  // Reverse direction: the spec guarantees the field, the type says it may be
  // absent. Harmless on the wire — but the type is the record a consumer reads,
  // and an optional member is a standing invitation to write a `?? fallback`
  // for a case the server cannot produce. That is exactly how
  // `ResolvedRunConfig.generation` / `.input` acquired their "compatibility
  // with older servers" tolerance while the spec required both.
  //
  // Only a field the type declares as absent-able counts — `x?: T` or
  // `x: T | undefined`, which `getTypeShape` reads as one fact. A field the
  // type omits entirely is a different fact (the type models a subset of the
  // wire, which is legal and common), and `required` ∪ `optional` is the
  // declared set — which is why `optional` is carried through rather than
  // inferred as the complement of `required`.
  for (const field of norm.required) {
    const label = prefix ? `${prefix}.${field}` : field;
    const exempted = exemptionFor(exempt.reverse, label, field, prefix);
    if (exempted !== null) {
      if (shape.optional.has(field)) exempt.used.reverse.add(exempted);
      continue;
    }
    if (shape.optional.has(field)) {
      issues.push(`Field "${label}": OpenAPI=required, shared-type=optional`);
    }
  }

  for (const field of shape.required) {
    const label = prefix ? `${prefix}.${field}` : field;
    const exempted = exemptionFor(exempt.forward, label, field, prefix);
    if (exempted !== null) {
      // Same drift test as the two branches below, read for liveness only.
      if (specProps.has(field) ? !norm.required.has(field) : !norm.open) {
        exempt.used.forward.add(exempted);
      }
      continue;
    }
    if (!specProps.has(field)) {
      // An open object (additionalProperties / Record) legitimately omits the key.
      if (!norm.open) {
        issues.push(
          `Field "${label}": shared-type=required, OpenAPI=absent (not a declared property)`,
        );
      }
      continue;
    }
    if (!norm.required.has(field)) {
      issues.push(`Field "${label}": shared-type=required, OpenAPI=optional`);
    }
    const childShape = shape.nested.get(field);
    if (childShape) {
      const childNorm = normalizeSpecSchema(norm.properties[field]);
      if (childNorm?.items) {
        compareShapeToSchema(childShape, childNorm.items, `${label}[]`, exempt, issues, depth + 1);
      } else {
        compareShapeToSchema(childShape, norm.properties[field], label, exempt, issues, depth + 1);
      }
    }
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Extract the request-body JSON Schema from the OpenAPI spec for a given path+method.
 * Returns undefined if the endpoint has no requestBody or no application/json content.
 * Resolves top-level `$ref` pointers so the comparison gets the actual schema.
 */
/**
 * A schema position that may hold a nested schema — `items`, or
 * `additionalProperties` when it is a schema rather than the boolean form.
 */
/**
 * The JSON media types a request body can be declared under.
 *
 * `application/json` plus the RFC 6839 `+json` structured suffix. The gate used
 * to match the first exactly and dismiss the rest as having "no JSON schema to
 * compare a Zod object against" — true for the multipart, form-encoded and
 * octet-stream bodies, and false for exactly one endpoint:
 * `POST /api/runs/{runId}/events` declares `application/cloudevents+json` with
 * a hand-written 8-key schema, validated by a `.strict()` Zod object with the
 * same 8 keys. It is the most skew-exposed body on the surface — the envelope
 * is strict, so a spec/Zod divergence 400s the whole event, and it is the
 * runtime→platform boundary the image-tag lockstep admits it cannot cover in
 * three cases.
 */
function jsonBodySchemaOf(
  content: Record<string, { schema?: unknown }> | undefined,
): unknown | undefined {
  if (!content) return undefined;
  for (const [mediaType, entry] of Object.entries(content)) {
    if (/^application\/([\w.+-]+\+)?json$/.test(mediaType)) return entry?.schema;
  }
  return undefined;
}

function asSchemaObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Compare the scalar JSON-Schema keywords of one value position.
 *
 * UNIDIRECTIONAL by design: a constraint present in Zod but missing or
 * differing in OpenAPI is flagged; an OpenAPI-only constraint is not. Zod is
 * the runtime source of truth, so a Zod constraint absent from the spec is the
 * drift that misleads consumers, while the spec legitimately carries
 * descriptive constraints Zod does not enforce. KNOWN LIMITATION: tightening to
 * bidirectional would require reconciling that pre-existing hand-authored drift
 * first.
 *
 * `label` is the reported position — `field`, `field[]` for array items, or
 * `field[*]` for a record's values.
 */
function compareValueConstraints(
  label: string,
  zodProp: Record<string, unknown>,
  oaProp: Record<string, unknown>,
  issues: string[],
): void {
  // maxLength (check anyOf variants for Zod nullable types)
  const zodMaxLen =
    zodProp.maxLength ??
    (zodProp.anyOf as Record<string, unknown>[] | undefined)?.find((v) => v.maxLength)?.maxLength;
  const oaMaxLen = oaProp.maxLength;
  if (zodMaxLen !== undefined && oaMaxLen !== undefined && zodMaxLen !== oaMaxLen) {
    issues.push(`Property "${label}" maxLength: Zod=${zodMaxLen}, OpenAPI=${oaMaxLen}`);
  }
  if (zodMaxLen !== undefined && oaMaxLen === undefined) {
    issues.push(`Property "${label}" maxLength: Zod=${zodMaxLen}, OpenAPI=unset`);
  }

  // minLength
  const zodMinLen =
    zodProp.minLength ??
    (zodProp.anyOf as Record<string, unknown>[] | undefined)?.find((v) => v.minLength)?.minLength;
  const oaMinLen = oaProp.minLength;
  if (zodMinLen !== undefined && oaMinLen !== undefined && zodMinLen !== oaMinLen) {
    issues.push(`Property "${label}" minLength: Zod=${zodMinLen}, OpenAPI=${oaMinLen}`);
  }
  if (zodMinLen !== undefined && oaMinLen === undefined) {
    issues.push(`Property "${label}" minLength: Zod=${zodMinLen}, OpenAPI=unset`);
  }

  // Pattern
  if (zodProp.pattern && oaProp.pattern && zodProp.pattern !== oaProp.pattern) {
    issues.push(
      `Property "${label}" pattern: Zod="${zodProp.pattern}", OpenAPI="${oaProp.pattern}"`,
    );
  }

  // Format (check anyOf variants for Zod nullable types)
  const zodFormat =
    zodProp.format ??
    (zodProp.anyOf as Record<string, unknown>[] | undefined)?.find((v) => v.format)?.format;
  if (zodFormat && oaProp.format && zodFormat !== oaProp.format) {
    issues.push(`Property "${label}" format: Zod="${zodFormat}", OpenAPI="${oaProp.format}"`);
  }

  // Enum values
  if (zodProp.enum && oaProp.enum) {
    const zodEnumStr = JSON.stringify([...(zodProp.enum as unknown[])].sort());
    const oaEnumStr = JSON.stringify([...(oaProp.enum as unknown[])].sort());
    if (zodEnumStr !== oaEnumStr) {
      issues.push(`Property "${label}" enum: Zod=${zodEnumStr}, OpenAPI=${oaEnumStr}`);
    }
  }
}

function getOpenApiRequestBodySchema(
  specPath: string,
  method: string,
): Record<string, unknown> | undefined {
  const pathObj = (openApiSpec.paths as Record<string, Record<string, unknown>>)[specPath];
  if (!pathObj) return undefined;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const operation = pathObj[method.toLowerCase()] as any;
  if (!operation?.requestBody) return undefined;

  let schema = jsonBodySchemaOf(operation.requestBody?.content) as
    Record<string, unknown> | undefined;

  // Resolve top-level $ref
  if (schema && typeof schema.$ref === "string") {
    schema = resolveRef(schema.$ref);
  }

  return schema;
}

/**
 * Normalize a JSON Schema type to a comparable form.
 * Handles OpenAPI's `type: ["string", "null"]` vs JSON Schema's `anyOf` from Zod.
 */
function normalizeType(schema: Record<string, unknown>): {
  baseTypes: string[];
  nullable: boolean;
} {
  if (typeof schema.$ref === "string") {
    const resolved = resolveRef(schema.$ref);
    return resolved ? normalizeType(resolved) : { baseTypes: [], nullable: false };
  }

  // `allOf` is a conjunction, not a union: merge the branches' base types with
  // any sibling `type`. Without this a component built as
  // `{ allOf: [ {$ref: <external>}, {type:"object", …} ] }` — the AFPS manifest
  // schemas — normalizes to no type at all and reads as drift against a Zod
  // `z.record(...)`.
  if (Array.isArray(schema.allOf)) {
    const normalized = (schema.allOf as Record<string, unknown>[]).map(normalizeType);
    const merged = new Set(normalized.flatMap((branch) => branch.baseTypes));
    if (typeof schema.type === "string") merged.add(schema.type);
    if (merged.size > 0) {
      return {
        baseTypes: [...merged].sort(),
        nullable: normalized.some((branch) => branch.nullable),
      };
    }
  }

  const variants = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : null;
  if (variants) {
    // Zod and hand-authored OpenAPI use unions for nullable refs and scalars.
    const normalized = (variants as Record<string, unknown>[]).map(normalizeType);
    const baseTypes = [...new Set(normalized.flatMap((variant) => variant.baseTypes))].sort();
    // A `oneOf` whose branches carry no `type` is not a type union — it is a
    // constraint list on a node that declares its own type alongside it (the
    // "exactly one of these keys is required" idiom). Fall through to the
    // sibling `type` rather than reporting "no type".
    if (baseTypes.length > 0 || schema.type === undefined) {
      return {
        baseTypes,
        nullable: normalized.some((variant) => variant.nullable),
      };
    }
  }

  if (Array.isArray(schema.type)) {
    // OpenAPI style: type: ["string", "null"]
    const types = (schema.type as string[]).filter((t) => t !== "null").sort();
    const nullable = (schema.type as string[]).includes("null");
    return { baseTypes: types, nullable };
  }

  if (typeof schema.type === "string") {
    return schema.type === "null"
      ? { baseTypes: [], nullable: true }
      : { baseTypes: [schema.type], nullable: false };
  }

  return { baseTypes: [], nullable: false };
}

interface SchemaDiscrepancy {
  entry: OpenApiSchemaEntry;
  issues: string[];
}

const discrepancies: SchemaDiscrepancy[] = [];
let comparedCount = 0;

for (const entry of zodSchemaRegistry) {
  const openApiSchema = getOpenApiRequestBodySchema(entry.path, entry.method);

  if (!openApiSchema) {
    discrepancies.push({
      entry,
      issues: [`No OpenAPI requestBody schema found for ${entry.method} ${entry.path}`],
    });
    continue;
  }

  // The registry pre-converts Zod schemas to JSON Schema via z.toJSONSchema()
  const zodJsonSchema = entry.jsonSchema;

  comparedCount++;
  const issues: string[] = [];

  // --- Compare required fields ---
  const zodRequired = new Set<string>(
    Array.isArray(zodJsonSchema.required) ? (zodJsonSchema.required as string[]) : [],
  );
  const oaRequired = new Set<string>(
    Array.isArray(openApiSchema.required) ? (openApiSchema.required as string[]) : [],
  );

  for (const field of zodRequired) {
    if (!oaRequired.has(field)) {
      issues.push(`Required field "${field}": Zod=required, OpenAPI=optional`);
    }
  }
  for (const field of oaRequired) {
    if (!zodRequired.has(field)) {
      issues.push(`Required field "${field}": OpenAPI=required, Zod=optional`);
    }
  }

  // --- Compare properties ---
  const zodProps = (zodJsonSchema.properties || {}) as Record<string, Record<string, unknown>>;
  const oaProps = (openApiSchema.properties || {}) as Record<string, Record<string, unknown>>;

  const zodPropNames = new Set(Object.keys(zodProps));
  const oaPropNames = new Set(Object.keys(oaProps));

  // Fields in Zod but not in OpenAPI
  for (const field of zodPropNames) {
    if (!oaPropNames.has(field)) {
      issues.push(`Property "${field}": present in Zod but missing from OpenAPI`);
    }
  }

  // Fields in OpenAPI but not in Zod
  for (const field of oaPropNames) {
    if (!zodPropNames.has(field)) {
      issues.push(`Property "${field}": present in OpenAPI but missing from Zod`);
    }
  }

  // Compare shared properties in detail
  for (const field of zodPropNames) {
    if (!oaPropNames.has(field)) continue;

    const zodProp = zodProps[field]!;
    const oaProp = oaProps[field]!;

    // Type comparison (normalizes nullable representations)
    const zodType = normalizeType(zodProp);
    const oaType = normalizeType(oaProp);

    if (zodType.baseTypes.join(",") !== oaType.baseTypes.join(",")) {
      issues.push(
        `Property "${field}" type: Zod=[${zodType.baseTypes}], OpenAPI=[${oaType.baseTypes}]`,
      );
    }

    if (zodType.nullable !== oaType.nullable) {
      issues.push(
        `Property "${field}" nullable: Zod=${zodType.nullable}, OpenAPI=${oaType.nullable}`,
      );
    }

    // The scalar keyword comparison, applied to the property AND to the two
    // places a constraint can hide one level down.
    //
    // This used to be inline, and only the property's own keywords were read.
    // `connection_overrides` is `z.record(z.string(), z.string().min(1))`: the
    // `minLength` lives on the record's VALUES, i.e. on `additionalProperties`,
    // so `zodProp.minLength` was `undefined` on both sides and every branch was
    // skipped — the gate reported nothing. That is not hypothetical: 875df353f
    // documents finding and fixing exactly that drift BY HAND, on three run
    // surfaces, in the same range this gate was written.
    compareValueConstraints(field, zodProp, oaProp, issues);

    const zodAdditional = asSchemaObject(zodProp.additionalProperties);
    const oaAdditional = asSchemaObject(oaProp.additionalProperties);
    if (zodAdditional && oaAdditional) {
      compareValueConstraints(`${field}[*]`, zodAdditional, oaAdditional, issues);
    }

    // Array item type
    if (zodProp.type === "array" && oaProp.type === "array") {
      const zodItems = asSchemaObject(zodProp.items);
      const oaItems = asSchemaObject(oaProp.items);
      if (zodItems?.type && oaItems?.type && zodItems.type !== oaItems.type) {
        issues.push(
          `Property "${field}" array items type: Zod=${zodItems.type}, OpenAPI=${oaItems.type}`,
        );
      }
      if (zodItems && oaItems) {
        compareValueConstraints(`${field}[]`, zodItems, oaItems, issues);
      }
    }

    // Array minItems
    if (zodProp.minItems !== undefined && oaProp.minItems !== undefined) {
      if (zodProp.minItems !== oaProp.minItems) {
        issues.push(
          `Property "${field}" minItems: Zod=${zodProp.minItems}, OpenAPI=${oaProp.minItems}`,
        );
      }
    }
  }

  if (issues.length > 0) {
    discrepancies.push({ entry, issues });
  }
}

console.log(`  Compared: ${comparedCount}/${zodSchemaRegistry.length} registry entries\n`);

if (discrepancies.length === 0) {
  console.log(`  OK — all Zod schemas match their OpenAPI counterparts.`);
} else {
  exitCode = 1;
  console.log(`  ${discrepancies.length} endpoint(s) with discrepancies:\n`);
  for (const d of discrepancies) {
    console.log(`  ERROR  ${d.entry.method} ${d.entry.path} (${d.entry.description})`);
    for (const issue of d.issues) {
      console.log(`          - ${issue}`);
    }
    console.log();
  }
}

// Coverage enforcement — every endpoint whose spec declares an
// `application/json` request body must be either registered (compared above)
// or explicitly exempt with a stated reason. Without this the registry is
// opt-in: a launch surface can accept fields its documented body never
// mentions, and nothing notices. Same shape as §7b for response schemas.
//
// The universe is the SPEC, not the `readJsonBody()` call sites: the spec is
// the published contract, and §5/§5b already assert that code and spec carry
// the same endpoint set. Non-JSON bodies (multipart uploads, form-encoded
// OAuth2, octet-stream) are out of scope — there is genuinely no JSON schema to
// compare a Zod object against. `application/cloudevents+json` IS in scope: it
// carries a hand-written JSON schema and a `.strict()` Zod object, and listing
// it as exempt was the gate's one blind spot. See `jsonBodySchemaOf`.
{
  const registeredEndpoints = new Set(
    zodSchemaRegistry.map((e) => `${e.method.toUpperCase()} ${e.path}`),
  );
  const jsonBodyEndpoints: string[] = [];
  for (const [path, methods] of Object.entries(paths)) {
    for (const [method, op] of Object.entries(methods)) {
      const body = (op as { requestBody?: { content?: Record<string, { schema?: unknown }> } })
        ?.requestBody;
      if (jsonBodySchemaOf(body?.content) === undefined) continue;
      jsonBodyEndpoints.push(`${method.toUpperCase()} ${path}`);
    }
  }
  const uncoveredBodies = jsonBodyEndpoints
    .filter((k) => !registeredEndpoints.has(k) && !(k in EXEMPT_REQUEST_BODIES))
    .sort();
  // A stale exemption (endpoint removed, or its body registered after all) is
  // also a failure — keep the list honest.
  const jsonBodySet = new Set(jsonBodyEndpoints);
  const staleExemptBodies = Object.keys(EXEMPT_REQUEST_BODIES)
    .filter((k) => !jsonBodySet.has(k) || registeredEndpoints.has(k))
    .sort();

  console.log(`\n  4b. Step 4 coverage (every JSON request body registered or exempt)`);
  console.log(`  ------------------------------------------------------------------`);
  if (uncoveredBodies.length === 0 && staleExemptBodies.length === 0) {
    console.log(
      `  OK — all ${jsonBodyEndpoints.length} JSON request bodies are registered ` +
        `(${jsonBodyEndpoints.length - Object.keys(EXEMPT_REQUEST_BODIES).length}) or exempt ` +
        `(${Object.keys(EXEMPT_REQUEST_BODIES).length}).`,
    );
  } else {
    exitCode = 1;
    if (uncoveredBodies.length > 0) {
      console.log(
        `  Endpoint(s) with a JSON request body that is neither registered nor exempt ` +
          `(${uncoveredBodies.length}):`,
      );
      for (const k of uncoveredBodies) console.log(`    - ${k}`);
      console.log(
        `\n  Register the route's Zod schema in apps/api/src/openapi/zod-schema-registry.ts ` +
          `(or the owning module's openApiSchemas()), or add the endpoint to ` +
          `EXEMPT_REQUEST_BODIES with the reason it has no comparable schema.`,
      );
    }
    if (staleExemptBodies.length > 0) {
      console.log(`\n  Stale EXEMPT_REQUEST_BODIES entries (endpoint gone, or now registered):`);
      for (const k of staleExemptBodies) console.log(`    - ${k}`);
    }
  }
}

// ═══════════════════════════════════════════════════
// 5. Code ⊆ Spec
// ═══════════════════════════════════════════════════
//
// Static analysis of `router.METHOD(...)` / `app.METHOD(...)` registrations
// across `apps/api/src/routes/*.ts`, `apps/api/src/modules/*/routes.ts` and
// `apps/api/src/index.ts`. The mount prefix for each route file is composed
// from `app.route(prefix, factory)` calls in `index.ts`. Every code-registered
// endpoint that is neither in the spec nor in the explicit allowlist below is
// reported as orphan and fails the run.
//
// Files registered via runtime config (e.g. `routes/llm-proxy.ts` registers
// routes inside a config-driven `for` loop) and Better Auth's catchall
// (`/api/auth/*`, plugin-registered) are skipped and the corresponding
// endpoints are left to coverage check #1 to keep in sync.

console.log(`\n  5. Code ⊆ Spec`);
console.log(`  ----------------`);

interface RouteRegistration {
  verb: string;
  path: string;
  /** Error statuses the handler is statically certain to be able to return. */
  statuses: Set<string>;
}

const ROUTE_VERBS = ["get", "post", "put", "patch", "delete", "all", "head", "options"] as const;
const ROUTE_VERB_PATTERN = ROUTE_VERBS.join("|");

/**
 * Shared bracket-matching scanner used by {@link extractFunctionBody} and
 * {@link extractCallText}. Walks `src` from `start`, invoking `onCodeChar(ch, i)`
 * only for characters OUTSIDE string / template / line- / block-comment content,
 * so a bracket inside a string or comment cannot throw off a caller's depth
 * count. The callback returns `true` to stop the scan (its matching bracket
 * closed); the scan otherwise runs to end-of-source.
 *
 * KNOWN LIMITATION: regex literals (e.g. `/\}/`) are NOT tokenized — a bracket
 * inside a regex literal can still miscount. Distinguishing a regex literal
 * from a division operator needs a real tokenizer (JS grammar is
 * context-sensitive here); that is out of scope for this static gate. In
 * practice the scanned route-registration functions contain no such literals.
 */
function scanSkippingStringsAndComments(
  src: string,
  start: number,
  onCodeChar: (ch: string, i: number) => boolean | void,
): void {
  let inStr: string | null = null;
  let inLine = false;
  let inBlock = false;
  let i = start;
  while (i < src.length) {
    const ch = src[i]!;
    const next = src[i + 1];
    if (inLine) {
      if (ch === "\n") inLine = false;
      i++;
      continue;
    }
    if (inBlock) {
      if (ch === "*" && next === "/") {
        inBlock = false;
        i++;
      }
      i++;
      continue;
    }
    if (inStr) {
      if (ch === "\\")
        i++; // skip escaped char
      else if (ch === inStr) inStr = null;
      i++;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLine = true;
      i += 2;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlock = true;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inStr = ch;
      i++;
      continue;
    }
    if (onCodeChar(ch, i) === true) return;
    i++;
  }
}

/**
 * Find the body of a top-level `function`/`export function` declaration by
 * locating its opening `{` after `name(...)` and brace-counting forward via
 * {@link scanSkippingStringsAndComments}. Returns the source slice between the
 * matching braces (exclusive), or null if the function isn't found or the braces
 * never balance — which would otherwise hide the `router.METHOD(...)`
 * registrations that live past a miscounted brace.
 */
function extractFunctionBody(src: string, fnName: string): string | null {
  const sigPattern = new RegExp(`(?:export\\s+)?function\\s+${fnName}\\s*\\(`, "g");
  const sig = sigPattern.exec(src);
  if (!sig) return null;
  const openIdx = src.indexOf("{", sig.index + sig[0].length);
  if (openIdx === -1) return null;
  let depth = 1;
  let closeIdx = -1;
  scanSkippingStringsAndComments(src, openIdx + 1, (ch, i) => {
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        closeIdx = i;
        return true;
      }
    }
  });
  return closeIdx === -1 ? null : src.slice(openIdx + 1, closeIdx);
}

/**
 * Capture a `router.METHOD( … )` call's full source text starting at its
 * opening `(`, paren-matching to the matching `)` via
 * {@link scanSkippingStringsAndComments}. Returns the slice INCLUDING both
 * parens, or null if unbalanced.
 */
function extractCallText(src: string, openParenIdx: number): string | null {
  let depth = 0;
  let closeIdx = -1;
  scanSkippingStringsAndComments(src, openParenIdx, (ch, i) => {
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) {
        closeIdx = i;
        return true;
      }
    }
  });
  return closeIdx === -1 ? null : src.slice(openParenIdx, closeIdx + 1);
}

/**
 * Infer the error status codes a route handler is GUARANTEED able to return,
 * from statically-certain signals in its `router.METHOD(...)` call text (guards
 * + handler body). Only SOUND signals (zero false positives) are used:
 *   - `requirePermission` / `requireCorePermission` / `requireModulePermission`
 *     middleware → 403 (the guard always 403s a caller lacking the permission).
 *   - `parseBody(` in the handler → 400 (it throws `invalidRequest` on a bad body).
 * 404 is deliberately NOT inferred: most `notFound` throws live deep in the
 * service layer (e.g. `setDefaultModel`), invisible at the route, so a 404
 * signal would be unsound in both directions. Comments are stripped first so a
 * commented-out guard never yields a phantom requirement.
 */
function inferRequiredStatuses(callText: string): Set<string> {
  const code = callText.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const out = new Set<string>();
  if (/\brequire(?:Core|Module)?Permission\s*\(/.test(code)) out.add("403");
  if (/\bparseBody\s*\(/.test(code)) out.add("400");
  // A per-route rate limiter at the registration site always 429s a caller over
  // the limit — same registration-site evidence as the 403/400 guards above, so
  // it is inferable just as soundly. Matches the whole family: `rateLimit(`,
  // `rateLimitByIp/ByRunId/ByBearer(`, `rateLimitMcp(`, and the chat module's
  // `rateLimited(` wrapper. (404, by contrast, comes from `notFound` throws deep
  // in the service layer — invisible here — so it stays un-inferred.)
  if (/\brateLimit(?:ed|By[A-Za-z]+|Mcp)?\s*\(/.test(code)) out.add("429");
  return out;
}

/**
 * Templated `router.METHOD(`…${ident}…`)` registrations that could not be
 * resolved from in-file literals. Populated by `extractRouterRegistrations`
 * and turned into a hard failure after step 5 — a `${…}` route the extractor
 * can't expand would otherwise silently escape the Code ⊆ Spec check (a new
 * undocumented config-loop route would pass CI). Fail closed instead.
 */
const unresolvedTemplatedRoutes: { file: string; verb: string; raw: string }[] = [];

/**
 * Resolve a relative import specifier from an `apps/api/src` file to another
 * `apps/api/src` file key (`routes/foo`, `modules/bar/router`, ...). External
 * imports intentionally return null: the route verifier must fail closed rather
 * than chasing arbitrary package code.
 */
function resolveLocalImportFile(currentFile: string, source: string): string | null {
  if (!source.startsWith(".")) return null;
  const apiSrcRoot = normalize(join(REPO_ROOT, "apps/api/src"));
  const currentFull = join(apiSrcRoot, currentFile + ".ts");
  const sourceWithExt = source.endsWith(".ts") ? source : `${source}.ts`;
  const importedFull = normalize(join(dirname(currentFull), sourceWithExt));
  const rel = relative(apiSrcRoot, importedFull);
  if (rel.startsWith("..") || rel.startsWith("/") || !rel.endsWith(".ts")) return null;
  // The specifier has to name a file that EXISTS. Without this, a `./foo`
  // resolving to a directory index, a `.tsx`, or a moved module produced a
  // plausible-looking relative path that `readRouteFile` then read as "" — the
  // silent-empty-source path this pass closed. Returning null here is the
  // honest answer ("not a local .ts module"), and it is what lets
  // `readRouteFile` throw on a genuinely missing file instead of shrugging.
  if (!existsSync(importedFull)) return null;
  return rel.slice(0, -3).replace(/\\/g, "/");
}

/**
 * Look up local named imports that bind `ident` in this source file:
 * `import { X as ident } from "./local.ts"` or `import { ident } from "./local.ts"`.
 */
function lookupImportedIdentSources(
  ident: string,
  fullSrc: string,
  file: string | undefined,
): Array<{ imported: string; file: string }> {
  if (!file) return [];
  const out: Array<{ imported: string; file: string }> = [];
  for (const m of fullSrc.matchAll(/import\s+\{([^}]+)\}\s+from\s+["']([^"']+)["']/g)) {
    const sourceFile = resolveLocalImportFile(file, m[2]!);
    if (!sourceFile) continue;
    for (const raw of m[1]!.split(",")) {
      const [importedRaw, localRaw] = raw.split(/\s+as\s+/);
      const imported = importedRaw?.trim();
      const local = (localRaw ?? importedRaw)?.trim();
      if (imported && local === ident) out.push({ imported, file: sourceFile });
    }
  }
  return out;
}

/**
 * Look up the string/template-literal value(s) bound to `ident` in a source
 * file, via either a top-level const (`const <ident> = "lit"`), an object-literal
 * field (`<ident>: "lit"`), or a local named import that resolves to either of
 * those forms. The captured value may itself be a template literal that still
 * contains `${…}` (e.g. `const MCP_PATH = \`${MCP_PREFIX}/:org\``) — callers
 * must recurse to fully resolve it.
 */
function lookupIdentLiterals(
  ident: string,
  fullSrc: string,
  file?: string,
  seen = new Set<string>(),
): string[] {
  const literals = new Set<string>();
  const constRe = new RegExp(`\\bconst\\s+${ident}\\s*=\\s*["'\`]([^"'\`]+)["'\`]`, "g");
  for (const m of fullSrc.matchAll(constRe)) literals.add(m[1]!);
  const fieldRe = new RegExp(`\\b${ident}\\s*:\\s*["'\`]([^"'\`]+)["'\`]`, "g");
  for (const m of fullSrc.matchAll(fieldRe)) literals.add(m[1]!);
  if (literals.size > 0) return [...literals];

  for (const source of lookupImportedIdentSources(ident, fullSrc, file)) {
    const key = `${source.file}:${source.imported}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const importedSrc = readRouteFile(source.file);
    for (const lit of lookupIdentLiterals(source.imported, importedSrc, source.file, seen)) {
      literals.add(lit);
    }
  }
  return [...literals];
}

/**
 * Resolve `${ident}` interpolations in a templated route path against literals
 * declared in the same source file:
 *   - `const <ident> = "literal"`              (top-level const)
 *   - `<ident>: "literal"`                     (object-literal field, e.g. the
 *     `path:` members of a config table the route loop destructures —
 *     `for (const rcfg of Object.values(ROUTE_CONFIGS)) { const { path } = rcfg; router.get(`/${path}/…`) }`)
 * Resolution is recursive: a resolved literal may itself be a template that
 * references further consts (e.g. `PRM_PATH` → `\`${PRM_PATH_PREFIX}${MCP_PATH}\``
 * → `${PRM_PATH_PREFIX}${MCP_PREFIX}/:org`). Returns every concrete path
 * (cross-product across multi-valued idents), or `null` if any `${…}` can't be
 * resolved or the nesting exceeds `depth` (caller fails closed).
 */
function resolveTemplatedPath(
  rawPath: string,
  fullSrc: string,
  file: string | undefined,
  depth = 0,
): string[] | null {
  if (depth > 10) return null; // cycle / runaway guard
  const idents = [...rawPath.matchAll(/\$\{([a-zA-Z_$][\w$]*)\}/g)].map((m) => m[1]!);
  if (idents.length === 0) return [rawPath];
  let paths = [rawPath];
  for (const ident of idents) {
    const literals = lookupIdentLiterals(ident, fullSrc, file);
    if (literals.length === 0) return null;
    paths = paths.flatMap((p) =>
      literals.map((lit) => p.replace(new RegExp(`\\$\\{${ident}\\}`, "g"), lit)),
    );
  }
  // A resolved literal may still contain `${…}` (nested template consts) — recurse.
  const out: string[] = [];
  for (const p of paths) {
    if (p.includes("${")) {
      const nested = resolveTemplatedPath(p, fullSrc, file, depth + 1);
      if (!nested) return null;
      out.push(...nested);
    } else {
      out.push(p);
    }
  }
  return out;
}

/**
 * Identifiers bound to a `new Hono(...)` instance in a source file. Route
 * registrations are matched against these exact names, so a router declared as
 * `const profileRouter = new Hono()` or a module's `const app = new Hono()` is
 * caught — not just the `router` convention. This also avoids false positives
 * from unrelated `.get(` calls on Maps/Headers/etc., which are never Hono
 * instances.
 */
function honoInstanceIdents(src: string): string[] {
  const out = new Set<string>();
  for (const m of src.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*new\s+Hono\b/g)) out.add(m[1]!);
  return [...out];
}

/**
 * Resolve a route registration's path argument (literal or bare identifier) to
 * concrete path(s), or `null` if unresolvable (caller fails closed). `lit` is
 * the captured string/template body (may contain `${…}`); `ref` is a bare
 * identifier path argument (e.g. `app.get(PRM_PATH, …)`) resolved against
 * in-file const/field literals.
 */
function resolvePathArg(
  lit: string | undefined,
  ref: string | undefined,
  fullSrc: string,
  file: string | undefined,
): string[] | null {
  if (lit !== undefined) {
    return lit.includes("${") ? resolveTemplatedPath(lit, fullSrc, file) : [lit];
  }
  if (ref !== undefined) {
    const literals = lookupIdentLiterals(ref, fullSrc, file);
    if (literals.length === 0) return null;
    const out: string[] = [];
    for (const l of literals) {
      const resolved = l.includes("${") ? resolveTemplatedPath(l, fullSrc, file) : [l];
      if (!resolved) return null;
      out.push(...resolved);
    }
    return out;
  }
  return null;
}

/**
 * Extract all `<honoInstance>.METHOD(path, …)` registrations from a slice of
 * source. `fullSrc` is the whole file (the slice may be a single function body)
 * so Hono-instance identifiers and `${ident}` / bare-identifier path arguments
 * can be resolved against file-level declarations. A path argument that can't
 * be resolved to a literal is pushed to `unresolvedTemplatedRoutes` so the run
 * fails closed rather than silently dropping the route.
 */
function extractRouterRegistrations(
  slice: string,
  fullSrc: string,
  file: string,
): RouteRegistration[] {
  const out: RouteRegistration[] = [];
  const idents = honoInstanceIdents(fullSrc);
  if (idents.length === 0) idents.push("router"); // pre-bound imported router fallback
  const identAlt = idents.join("|");
  // Path arg is either a quoted/template literal (group 2) or a bare identifier (group 3).
  const re = new RegExp(
    `\\b(?:${identAlt})\\.(${ROUTE_VERB_PATTERN})\\s*\\(\\s*(?:["'\`]([^"'\`]*)["'\`]|([A-Za-z_$][\\w$]*))`,
    "g",
  );
  for (const m of slice.matchAll(re)) {
    const verb = m[1]!;
    const resolved = resolvePathArg(m[2], m[3], fullSrc, file);
    if (!resolved) {
      unresolvedTemplatedRoutes.push({ file, verb, raw: m[2] ?? m[3] ?? "<unknown>" });
      continue;
    }
    // Capture the whole call (guards + handler) to infer guaranteed error
    // statuses. `m[0]` ends after the path arg; its first `(` is the METHOD's
    // open paren.
    const openParen = m.index + m[0].indexOf("(");
    const callText = extractCallText(slice, openParen);
    const statuses = callText ? inferRequiredStatuses(callText) : new Set<string>();
    for (const p of resolved) out.push({ verb, path: p, statuses });
  }
  return out;
}

/**
 * Normalise a Hono path to the OpenAPI equivalent.
 *  - `:id`              → `{id}`
 *  - `:scope{@[^/]+}`   → `{scope}`  (regex-constrained param)
 */
function normaliseHonoPath(path: string): string {
  return path.replace(/:(\w+)\{[^}]+\}/g, "{$1}").replace(/:(\w+)/g, "{$1}");
}

/**
 * Compose a mount prefix and a sub-path safely (handles trailing slashes
 * and the empty / `/` sub-path).
 */
function joinMountPath(prefix: string, sub: string): string {
  const trimmedPrefix = prefix.replace(/\/+$/, "");
  if (!sub || sub === "/") return trimmedPrefix || "/";
  const trimmedSub = sub.startsWith("/") ? sub : "/" + sub;
  return trimmedPrefix + trimmedSub || "/";
}

/**
 * Expand a registration into one or more `"VERB PATH"` entries (handles
 * `router.all(...)` and `app.all(...)`).
 */
function expandRegistration(verb: string, fullPath: string): string[] {
  if (verb === "all") {
    return ["GET", "POST", "PUT", "PATCH", "DELETE"].map((v) => `${v} ${fullPath}`);
  }
  return [`${verb.toUpperCase()} ${fullPath}`];
}

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const indexPath = join(REPO_ROOT, "apps/api/src/index.ts");
const indexSrc = readFileSync(indexPath, "utf8");

// 1. Build the import map for `./routes/<file>` imports in index.ts
//    - Named:   `import { createXRouter } from "./routes/x.ts"`
//    - Default: `import xRouter from "./routes/x.ts"`
//    - Mixed:   `import xRouter, { helper } from "./routes/x.ts"`
//
// The mixed form is in both patterns because omitting it cost real coverage:
// `import healthRouter, { bootGate, markServerReady } from "./routes/health.ts"`
// matched NEITHER pattern (the named one needs `import {` immediately, the
// default one needed `<ident> from`), so `healthRouter` resolved to no file and
// `app.route("/", healthRouter)` was dropped — every route health.ts declares
// was invisible to §5. It dropped in SILENCE; the mount resolver below now
// fails closed on an unresolved mount instead, which is how that was found.
const importToFile = new Map<string, string>(); // identifier → relative file path
for (const m of indexSrc.matchAll(
  /import\s+(?:\w+\s*,\s*)?\{([^}]+)\}\s+from\s+["']\.\/(routes\/[^"']+?)(?:\.ts)?["']/g,
)) {
  const file = m[2]!;
  for (const raw of m[1]!.split(",")) {
    const name = raw
      .trim()
      .split(/\s+as\s+/)[0]!
      .trim();
    if (name) importToFile.set(name, file);
  }
}
for (const m of indexSrc.matchAll(
  /import\s+(\w+)\s*(?:,\s*\{[^}]*\})?\s+from\s+["']\.\/(routes\/[^"']+?)(?:\.ts)?["']/g,
)) {
  importToFile.set(m[1]!, m[2]!);
}

// 2. Track `const x = createXRouter()` aliasing so `app.route(prefix, x)` resolves
const varToFactory = new Map<string, string>();
for (const m of indexSrc.matchAll(/(?:const|let)\s+(\w+)\s*=\s*(\w+)\s*\(\s*\)/g)) {
  varToFactory.set(m[1]!, m[2]!);
}

// 3. Parse `app.route("PREFIX", expr)` calls — expr is one of:
//    - `createFooRouter()`           → factory call
//    - `createFooRouter`             → factory reference (rare)
//    - `fooRouter`                   → variable bound to either `createFooRouter()` or default import
type Mount = { prefix: string; file: string; factory: string | "__default__" };
const mounts: Mount[] = [];
// Mounts whose expression resolves to no route file. COLLECTED, not thrown:
// this used to `throw`, which left the process with a raw uncaught stack trace
// — no section header, no `SOME CHECKS FAILED` summary, and none of the other
// sections' findings, because the throw happened at import time before §5 had
// printed anything. A legitimate mount the resolver has not been taught (an
// inline `const sub = new Hono(); app.route("/x", sub)` — none exists in
// index.ts today, `new Hono` appears once, for `app` itself) would have looked
// like a crashed tool rather than a gate saying no. It still fails closed; it
// now fails closed the way every other section does, in §5 below.
const unresolvedMounts: { prefix: string; expr: string; ident: string }[] = [];
// Matches both `app.route("/p", fooRouter)` and `app.route("/p", createFooRouter())`.
// The expression group accepts an identifier optionally followed by `()` — this is
// narrow enough to capture the trailing `)` of the factory call as part of the
// expression rather than as the closing paren of `app.route(...)`.
for (const m of indexSrc.matchAll(
  /app\.route\(\s*["']([^"']+)["']\s*,\s*(\w+(?:\(\s*\))?)\s*\)/g,
)) {
  const prefix = m[1]!;
  const exprRaw = m[2]!.trim();
  const isCall = /\(\s*\)$/.test(exprRaw);
  const ident = exprRaw.replace(/\(\s*\)$/, "").trim();

  // Resolve identifier
  let factory: string;
  let file: string | undefined;

  if (isCall) {
    // direct factory call: ident must be a named import
    file = importToFile.get(ident);
    factory = ident;
  } else {
    // variable: either an alias of a factory or a default import
    const aliasedFactory = varToFactory.get(ident);
    if (aliasedFactory) {
      file = importToFile.get(aliasedFactory);
      factory = aliasedFactory;
    } else {
      file = importToFile.get(ident);
      factory = "__default__";
    }
  }

  if (!file) {
    // An `app.route("/api/x", somethingUnresolvable)` used to be dropped here in
    // silence, taking every endpoint that router declares with it — the same
    // whole-mount hole `readRouteFile` had, one step earlier. There is no honest
    // fallback: without the file this gate cannot know what `/api/x` serves, so
    // it must not report on it.
    unresolvedMounts.push({ prefix, expr: exprRaw, ident });
    continue;
  }
  mounts.push({ prefix, file, factory });
}

// 4. Discovered code endpoints
const codeEndpoints = new Set<string>();
// "VERB PATH" → error statuses the handler is statically certain to return
// (union across every registration that maps to the same endpoint). Feeds the
// 5c documented-error-status check.
const codeRouteStatuses = new Map<string, Set<string>>();
function recordRouteStatuses(ep: string, statuses: Set<string>): void {
  if (statuses.size === 0) return;
  const existing = codeRouteStatuses.get(ep) ?? new Set<string>();
  for (const s of statuses) existing.add(s);
  codeRouteStatuses.set(ep, existing);
}

// 4a. Direct `app.METHOD("path", ...)` calls in index.ts
for (const m of indexSrc.matchAll(
  new RegExp(`app\\.(${ROUTE_VERB_PATTERN})\\s*\\(\\s*["']([^"']+)["']`, "g"),
)) {
  const verb = m[1]!;
  const path = normaliseHonoPath(m[2]!);
  for (const ep of expandRegistration(verb, path)) codeEndpoints.add(ep);
}

// 4b. Route files referenced by mounts — parse each factory body or default body
//     and combine with the mount prefix.
//
// A whole-file skip removes every route in that file from `codeEndpoints`, so
// §5 (Code ⊆ Spec) cannot see them. §5b (Spec ⊆ Code) only half-covers that: it
// reports a skipped file's endpoints as "registered by no router" if the spec
// ALREADY documents them, which is the case for a file being newly skipped. It
// reports NOTHING for a file whose endpoints were never documented — the spec
// side has nothing to iterate. The already-skipped
// `modules/firecracker/runner/server` demonstrates the shape: 13 routes, none
// in the spec, and this gate is silent about all of them (there, deliberately —
// see below).
//
// So widening this set IS a silent coverage hole for a new file, and the size
// assertion under it is the barrier. It is one literal rather than the
// `ALLOWED_SKIP_FILES` twin-set it replaces — that duplicate went stale under a
// rename without failing, whereas a count cannot disagree with itself.
const SKIP_FILES = new Set<string>([
  // Routes registered with a COMPUTED path (`router.post(llmProxyUrlPath(shape),
  // …)` — a call, not a string/template literal). The path can't be captured
  // statically, so the emitted endpoints are covered by SPEC_ONLY_ALLOWLIST in
  // §5b. (This used to describe `router.post(entry.urlPath, …)`, a bare
  // identifier read off a local config array; that array is gone. Before that
  // it read "covered by check #1", the hand-typed endpoint list §5b replaced.)
  // (packages.ts is NOT skipped: its template-literal
  // `${path}` routes are now expanded by resolveTemplatedPath against the
  // in-file ROUTE_CONFIGS `path:` literals and verified against the spec like
  // any literal route; an unresolvable `${…}` fails the run.)
  "routes/llm-proxy",
  // NOT a platform router: the appstrate-runner daemon's Hono app, served by
  // its own Bun.serve on the KVM host (modules/firecracker/runner/daemon.ts)
  // and never mounted into the platform API — its endpoints must NOT appear
  // in the platform OpenAPI spec. The wire contract is pinned by
  // modules/firecracker/runner/protocol.ts + the runner-server/roundtrip
  // unit tests instead.
  "modules/firecracker/runner/server",
]);

// The barrier. Both entries above are load-bearing and neither can be derived,
// so the only honest assertion is that the set still holds exactly what was
// reviewed. Checked with `!==`, not `>`: a narrowing is a SAFER state, but it
// leaves this constant claiming a file is skipped when it is not, and a gate
// whose own bookkeeping has drifted is the thing this branch exists to stop.
// The message below therefore names the right repair for each direction.
const SANCTIONED_SKIP_COUNT = 2;
if (SKIP_FILES.size !== SANCTIONED_SKIP_COUNT) {
  exitCode = 1;
  const widened = SKIP_FILES.size > SANCTIONED_SKIP_COUNT;
  console.log(`\n  5. Code ⊆ Spec — SKIP_FILES guard`);
  console.log(`  ---------------------------------`);
  console.log(
    `  ERROR  SKIP_FILES holds ${SKIP_FILES.size} entr${SKIP_FILES.size === 1 ? "y" : "ies"}, ` +
      `expected ${SANCTIONED_SKIP_COUNT}: ` +
      `${[...SKIP_FILES].join(", ")}`,
  );
  console.log(
    widened
      ? `\n  A whole-file skip hides every route in that file from the Code ⊆ Spec check, ` +
          `and §5b cannot report what the spec never documented. Verify the file's ` +
          `literal-path routes individually, or — if a skip is genuinely unavoidable — ` +
          `raise SANCTIONED_SKIP_COUNT with a justifying comment so the decision is reviewed.`
      : `\n  A skip was REMOVED, which is a widening of coverage and almost certainly ` +
          `correct. Lower SANCTIONED_SKIP_COUNT to ${SKIP_FILES.size} so this constant ` +
          `stops asserting a skip that no longer exists.`,
  );
}

const routeFileCache = new Map<string, string>();

/**
 * Read a route file, or fail.
 *
 * This used to be `existsSync(full) ? readFileSync(full, "utf8") : ""`, and the
 * empty string travelled: a mount whose route file had moved contributed ZERO
 * endpoints to `codeEndpoints` and said nothing, so §5's "every code route is
 * in the spec" passed over a file it had never opened. That is precisely the
 * defect `SKIP_FILES` thirty lines above exists to bound — a whole-file skip
 * removes every route in that file from the check — except this one needed no
 * entry and no `SANCTIONED_SKIP_COUNT` review to happen.
 *
 * Every caller reaches here with a path that something already claimed is a
 * real module: `mounts` from a resolved `app.route(...)` import, and
 * `lookupIdentLiterals` from a specifier `resolveLocalImportFile` has confirmed
 * exists. A miss is therefore a broken assumption, not a normal case.
 */
function readRouteFile(relPath: string): string {
  const cached = routeFileCache.get(relPath);
  if (cached !== undefined) return cached;
  const full = join(REPO_ROOT, "apps/api/src", relPath + ".ts");
  if (!existsSync(full)) {
    throw new Error(
      `verify-openapi: route file apps/api/src/${relPath}.ts does not exist, but something ` +
        `mounts or imports it. Skipping it would drop every route it declares from the ` +
        `Code ⊆ Spec check with no message — fix the path, or if the file is genuinely gone, ` +
        `remove the mount.`,
    );
  }
  const src = readFileSync(full, "utf8");
  routeFileCache.set(relPath, src);
  return src;
}

for (const mount of mounts) {
  if (SKIP_FILES.has(mount.file)) continue;
  // No `if (!src) continue` here any more: `readRouteFile` throws rather than
  // handing back an empty string, so an unreadable mount can no longer pass for
  // a mount with no routes.
  const src = readRouteFile(mount.file);

  let scope: string;
  if (mount.factory === "__default__") {
    scope = src;
  } else {
    const body = extractFunctionBody(src, mount.factory);
    if (body == null) continue;
    scope = body;
  }

  for (const reg of extractRouterRegistrations(scope, src, mount.file)) {
    const fullPath = normaliseHonoPath(joinMountPath(mount.prefix, reg.path));
    for (const ep of expandRegistration(reg.verb, fullPath)) {
      codeEndpoints.add(ep);
      recordRouteStatuses(ep, reg.statuses);
    }
  }
}

// 4c. Built-in module routes — ANY `.ts` file in a module dir that constructs a
//     Hono instance (not just `routes.ts`: the mcp module registers on a
//     `const app = new Hono()` in `router.ts`). Module routers mount at `/`
//     (paths are absolute in module routes).
const modulesDir = join(REPO_ROOT, "apps/api/src/modules");
function collectModuleRouteFiles(dir: string): string[] {
  const found: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      // Skip non-route subtrees: tests, openapi specs, vendored deps.
      if (ent.name === "test" || ent.name === "openapi" || ent.name === "node_modules") continue;
      found.push(...collectModuleRouteFiles(join(dir, ent.name)));
    } else if (ent.name.endsWith(".ts") && !ent.name.endsWith(".test.ts")) {
      found.push(join(dir, ent.name));
    }
  }
  return found;
}
if (existsSync(modulesDir)) {
  for (const name of readdirSync(modulesDir, { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    for (const filePath of collectModuleRouteFiles(join(modulesDir, name.name))) {
      const src = readFileSync(filePath, "utf8");
      if (!src.includes("new Hono")) continue; // only files that define a router
      const rel = "modules/" + filePath.slice(modulesDir.length + 1);
      // Same sanctioned whole-file skip as 4b (see SKIP_FILES' own comment for
      // why a widened skip still fails, at §5b).
      if (SKIP_FILES.has(rel.replace(/\.ts$/, ""))) continue;
      for (const reg of extractRouterRegistrations(src, src, rel)) {
        const fullPath = normaliseHonoPath(reg.path);
        for (const ep of expandRegistration(reg.verb, fullPath)) {
          codeEndpoints.add(ep);
          recordRouteStatuses(ep, reg.statuses);
        }
      }
    }
  }
}

// 4d. Workspace-package module routes (`packages/module-<name>/src/**`). These
//     are modules too (e.g. module-chat mounts /api/chat) and their openApiPaths
//     are now collected into the validated spec (see lib/module-openapi.ts), so
//     their code routes must be scanned here to keep Code ⊆ Spec balanced.
const workspaceModulesDir = join(REPO_ROOT, "packages");
for (const { name, srcDir } of discoverWorkspaceModuleDirs(workspaceModulesDir)) {
  for (const filePath of collectModuleRouteFiles(srcDir)) {
    const src = readFileSync(filePath, "utf8");
    if (!src.includes("new Hono")) continue; // only files that define a router
    const rel = name + "/src/" + filePath.slice(srcDir.length + 1);
    for (const reg of extractRouterRegistrations(src, src, rel)) {
      const fullPath = normaliseHonoPath(reg.path);
      for (const ep of expandRegistration(reg.verb, fullPath)) {
        codeEndpoints.add(ep);
        recordRouteStatuses(ep, reg.statuses);
      }
    }
  }
}

// 5. Allowlist — endpoints that exist in code by design but are intentionally
//    NOT documented in the OpenAPI spec.
const CODE_TO_SPEC_ALLOWLIST = new Set<string>([
  // OIDC HTML pages — server-rendered CSRF-hardened forms (Post-Redirect-Get),
  // not API endpoints. Convention across all OIDC implementations.
  "GET /api/oauth/login",
  "POST /api/oauth/login",
  "GET /api/oauth/register",
  "POST /api/oauth/register",
  "GET /api/oauth/consent",
  "POST /api/oauth/consent",
  "GET /api/oauth/forgot-password",
  "POST /api/oauth/forgot-password",
  "GET /api/oauth/reset-password",
  "POST /api/oauth/reset-password",
  "GET /api/oauth/magic-link",
  "POST /api/oauth/magic-link",
  "GET /api/oauth/magic-link/confirm",
  "POST /api/oauth/magic-link/confirm",
  // NB: /api/oauth/logout is intentionally absent — it is a GET-only redirect
  // documented in the spec (oidc/openapi/paths.ts), so it is not an orphan, and
  // there is no POST route. An allowlist entry for either verb would be dead.
  "GET /api/oauth/assets/social-sign-in.js",
  "GET /api/oauth/assets/login-expiry.js",
  // OIDC device-flow activation pages — server-rendered HTML.
  "GET /activate",
  "POST /activate",
  "POST /activate/approve",
  "POST /activate/deny",
  // SPA fallback + unknown-API guard registered directly in index.ts.
  "GET /api/*",
  "POST /api/*",
  "PUT /api/*",
  "PATCH /api/*",
  "DELETE /api/*",
  "GET /*",
  // Dev-time docs page served as plain text, not part of the JSON API.
  "GET /llms.txt",
  // Cookie-less HTML file preview — serves untrusted agent HTML (text/html)
  // from a hardened, session-less route OUTSIDE /api, authorized by a signed
  // token in the URL. Not a JSON API endpoint; intentionally undocumented in the
  // OpenAPI surface (no typed client, no SDK consumer).
  "GET /preview/files/{id}",
  // MCP per-org endpoint method-not-allowed catch-all: `app.all(MCP_PATH, …)`
  // throws 405 for every verb other than the documented POST + GET channels.
  // These three are the catch-all, not real endpoints.
  "PUT /api/mcp/o/{org}",
  "PATCH /api/mcp/o/{org}",
  "DELETE /api/mcp/o/{org}",
]);

const orphans = [...codeEndpoints]
  .filter((ep) => !specEndpoints.has(ep) && !CODE_TO_SPEC_ALLOWLIST.has(ep))
  .sort();

console.log(
  `  Code-registered endpoints: ${codeEndpoints.size}  (allowlist: ${CODE_TO_SPEC_ALLOWLIST.size})`,
);

if (orphans.length === 0) {
  console.log(`  OK — every code-registered endpoint is documented in the spec.`);
} else {
  exitCode = 1;
  console.log(`\n  Endpoints registered in code but missing from the spec (${orphans.length}):`);
  for (const ep of orphans) console.log(`    - ${ep}`);
  console.log(
    `\n  Either document the endpoint in apps/api/src/openapi/paths/, or add a ` +
      `justified entry to CODE_TO_SPEC_ALLOWLIST in this file.`,
  );
}

// Fail closed on any MOUNT the resolver couldn't resolve to a route file —
// every endpoint that router declares vanishes from `codeEndpoints` with it.
// Same policy as the templated-route block below, reported the same way.
if (unresolvedMounts.length > 0) {
  exitCode = 1;
  console.log(
    `\n  Mounts the resolver could not resolve to a route file (${unresolvedMounts.length}):`,
  );
  for (const m of unresolvedMounts) {
    console.log(`    - app.route("${m.prefix}", ${m.expr})  — unknown identifier "${m.ident}"`);
  }
  console.log(
    `\n  Every route mounted at those prefixes is invisible to the Code ⊆ Spec check. ` +
      `Import the router from a \`./routes/<file>\` module in apps/api/src/index.ts (named, ` +
      `default or mixed import, optionally through a \`const x = createXRouter()\` alias — the ` +
      `three forms documented above), or teach the resolver the new shape. Do not leave a ` +
      `mount unresolved.`,
  );
}

// Fail closed on any templated registration the resolver couldn't expand —
// an unresolved `${…}` route would otherwise vanish from `codeEndpoints` and
// silently escape the Code ⊆ Spec check.
if (unresolvedTemplatedRoutes.length > 0) {
  exitCode = 1;
  console.log(
    `\n  Templated route registrations the extractor could not resolve (${unresolvedTemplatedRoutes.length}):`,
  );
  for (const r of unresolvedTemplatedRoutes) {
    console.log(`    - ${r.file}: router.${r.verb}(\`${r.raw}\`)`);
  }
  console.log(
    `\n  Declare the interpolated identifier's literal value(s) in the same file ` +
      `(a top-level \`const x = "…"\` or an object \`x: "…"\` field the route loop ` +
      `destructures) so the verifier can expand and check it, or use a literal path.`,
  );
}

// ═══════════════════════════════════════════════════
// 5b. Spec ⊆ Code
// ═══════════════════════════════════════════════════
//
// The mirror of §5, and the one signal the deleted hand-typed
// `expectedEndpoints` list carried on its own: a path documented in the spec
// that no router actually registers. §5 catches code with no doc;
// detect-breaking-changes catches a doc that disappeared from the baseline;
// neither catches a doc that was never wired up, or whose route was deleted
// while the `paths/` entry stayed behind.
//
// Reuses `codeEndpoints` exactly as computed for §5 — same extractor, same
// mount-prefix composition, same Hono-syntax normalisation — so this check
// costs one set difference and stays correct by construction as routes move.

// Endpoints documented on purpose that `codeEndpoints` structurally cannot see,
// because the extractor only walks explicit `router.METHOD()` / `app.METHOD()`
// calls under apps/api/src/routes, apps/api/src/modules and index.ts. Same
// contract as CODE_TO_SPEC_ALLOWLIST: every entry needs a justifying comment.
const SPEC_ONLY_ALLOWLIST = new Set<string>([
  // Better Auth surface. `lib/auth-pipeline.ts` mounts the whole thing behind a
  // single wildcard — `app.on(["POST", "GET"], "/api/auth/*", …)` — so there is
  // no per-endpoint registration to find, and that file is a lib helper rather
  // than a routes/ or modules/ file the extractor walks. The spec documents the
  // individual operations because clients call them individually.
  // (`POST /api/auth/bootstrap/redeem` is deliberately absent: it is a real
  // platform router mounted ahead of the wildcard, so §5 already sees it.)
  "POST /api/auth/sign-up/email",
  "POST /api/auth/sign-in/email",
  "POST /api/auth/sign-out",
  "GET /api/auth/get-session",
  "GET /api/auth/jwks",
  "GET /api/auth/oauth2/authorize",
  "POST /api/auth/oauth2/token",
  "GET /api/auth/oauth2/userinfo",
  "POST /api/auth/oauth2/introspect",
  "POST /api/auth/oauth2/revoke",
  "POST /api/auth/device/code",
  "POST /api/auth/cli/token",
  "GET /api/auth/cli/sessions",
  "POST /api/auth/cli/sessions/revoke",
  "POST /api/auth/cli/sessions/revoke-all",
  "POST /api/auth/cli/revoke",

  // Registered, but through a mount shape the `app.route()` parser above does
  // not resolve — an extractor blind spot, not an undocumented design decision:
  //   - `GET /health`: `import healthRouter, { bootGate, … } from …` is a mixed
  //     default+named import, which the `import (\w+) from` pattern skips, so
  //     the default-export router never enters `importToFile`.
  //   - `GET /api/openapi.json`: mounted as
  //     `app.route("/", createOpenApiSpecRouter(getOpenApiSpec))`; the mount
  //     regex accepts `ident` or `ident()`, not a factory call with arguments.
  // Widening either pattern would let these two drop out of the allowlist.
  "GET /health",
  "GET /api/openapi.json",

  // LLM proxy shapes. `routes/llm-proxy.ts` mounts them from `LLM_PROXY_ROUTES`
  // via `llmProxyUrlPath(shape)`, a call this parser cannot evaluate, which is
  // why the whole file sits in SKIP_FILES; this exemption exists only because
  // §5b then compares against code endpoints the skip removed.
  //
  // DERIVED from that same table, not spelled out. Both the mount and the
  // document already read it — `openapi/paths/llm-proxy.ts` states in its own
  // header that hand-spelling the paths "is what would let the published
  // contract drift from a live endpoint with every check still green", and the
  // check it was talking about kept the last hand-written copy three files
  // away. Reading the table means a `baseSuffix` edit, or a fourth shape, moves
  // the mounted route, the document and this exemption in one step; the
  // symmetry between a client's base URL and the server's mount is asserted
  // directly in `packages/runner-pi/test/llm-proxy-routes.test.ts`.
  ...(Object.keys(LLM_PROXY_ROUTES) as ProxiedApiShape[]).map(
    (shape) => `POST /api/llm-proxy${llmProxyUrlPath(shape)}`,
  ),
]);

const undocumentedInCode = [...specEndpoints]
  .filter((ep) => !codeEndpoints.has(ep) && !SPEC_ONLY_ALLOWLIST.has(ep))
  .sort();

console.log(`\n  5b. Spec ⊆ Code`);
console.log(`  -----------------`);
console.log(
  `  Documented endpoints: ${specEndpoints.size}  (allowlist: ${SPEC_ONLY_ALLOWLIST.size})`,
);

if (undocumentedInCode.length === 0) {
  console.log(`  OK — every documented endpoint is registered in code.`);
} else {
  exitCode = 1;
  console.log(
    `\n  Endpoints documented in the spec but registered by no router (${undocumentedInCode.length}):`,
  );
  for (const ep of undocumentedInCode) console.log(`    - ${ep}`);
  console.log(
    `\n  Either delete the path entry from apps/api/src/openapi/paths/ (or the ` +
      `module's openApiPaths()), or add a justified entry to SPEC_ONLY_ALLOWLIST ` +
      `in this file.`,
  );
}

// Both allowlists are hand-maintained sets of exemptions, and an exemption that
// no longer applies is the failure mode the deleted `expectedEndpoints` array
// used to cover from the other direction: SPEC_ONLY_ALLOWLIST names endpoints
// §5b must not flag, so a documented endpoint that gets deleted from the spec
// stops being enumerated by ANY check here — the only remaining signal is
// `detect:breaking` against the committed baseline, which a legitimate
// `openapi:baseline` regeneration wipes. Assert both sets stay live. This is
// the same contract §4b's staleExemptBodies, §6's staleResponseSchema and §7's
// staleExempt already enforce for their own exemption lists.
const staleSpecOnly = [...SPEC_ONLY_ALLOWLIST].filter((ep) => !specEndpoints.has(ep)).sort();
const staleCodeToSpec = [...CODE_TO_SPEC_ALLOWLIST].filter((ep) => !codeEndpoints.has(ep)).sort();

if (staleSpecOnly.length === 0 && staleCodeToSpec.length === 0) {
  console.log(`  OK — both endpoint allowlists are free of stale entries.`);
} else {
  exitCode = 1;
  for (const [label, stale, source] of [
    ["SPEC_ONLY_ALLOWLIST", staleSpecOnly, "the spec"],
    ["CODE_TO_SPEC_ALLOWLIST", staleCodeToSpec, "code"],
  ] as const) {
    if (stale.length === 0) continue;
    console.log(`\n  Stale ${label} entries — no longer present in ${source} (${stale.length}):`);
    for (const ep of stale) console.log(`    - ${ep}`);
  }
  console.log(
    `\n  Delete the stale entries. An exemption that outlives its endpoint hides ` +
      `the endpoint's later removal from every check in this script.`,
  );
}

// ═══════════════════════════════════════════════════
// 5c. Documented error statuses
// ═══════════════════════════════════════════════════
//
// For every code-registered endpoint that IS documented, assert the spec
// declares the error statuses the handler is STATICALLY CERTAIN to return:
//   - a `requirePermission*` guard → 403
//   - a `parseBody(` body validation → 400
// (Sound, zero-false-positive signals only — see `inferRequiredStatuses`. 404
// is not inferred because most `notFound` throws originate in the service layer,
// invisible at the route.) This catches the "permission-guarded / body-parsing
// route returns 403/400 but the spec omits it" drift that the runtime response
// validator only catches when a test happens to exercise that exact error path.

console.log(`\n  5c. Documented Error Statuses`);
console.log(`  -------------------------------`);

// "VERB /path STATUS" pairs where the handler can return the status but the
// spec intentionally omits it. Each needs a justifying comment. Seeded empty —
// the codebase is clean; a new gap must be fixed or explicitly waived here.
const ERROR_STATUS_ALLOWLIST = new Set<string>([]);

const errorStatusGaps: string[] = [];
for (const [ep, inferred] of codeRouteStatuses) {
  if (!specEndpoints.has(ep)) continue; // orphans handled by the Code ⊆ Spec check
  const sepIdx = ep.indexOf(" ");
  const method = ep.slice(0, sepIdx).toLowerCase();
  const specPath = ep.slice(sepIdx + 1);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const op = (openApiSpec.paths as Record<string, any>)[specPath]?.[method];
  if (!op?.responses) continue;
  const documented = new Set(Object.keys(op.responses));
  for (const status of inferred) {
    if (documented.has(status)) continue;
    if (ERROR_STATUS_ALLOWLIST.has(`${ep} ${status}`)) continue;
    errorStatusGaps.push(`${ep} → missing "${status}"`);
  }
}
errorStatusGaps.sort();

console.log(`  Endpoints with inferred error statuses: ${codeRouteStatuses.size}`);
if (errorStatusGaps.length === 0) {
  console.log(`  OK — every guaranteed 400/403/429 is documented in the spec.`);
} else {
  exitCode = 1;
  console.log(
    `\n  Endpoint(s) whose handler can return an undocumented error status (${errorStatusGaps.length}):`,
  );
  for (const g of errorStatusGaps) console.log(`    - ${g}`);
  console.log(
    `\n  A \`requirePermission*\` guard always 403s, and \`parseBody(\` always 400s, on the ` +
      `failing path. Add the response to the endpoint in apps/api/src/openapi/paths/, or ` +
      `(if genuinely unreachable) waive it in ERROR_STATUS_ALLOWLIST in this file with a reason.`,
  );
}

// ═══════════════════════════════════════════════════
// 6. Response Schema Presence
// ═══════════════════════════════════════════════════
//
// Every 2xx response (except 204 No Content) must declare `content`, and every
// JSON media type must carry a `schema`. Without one, the generated frontend
// types (scripts/generate-api-types.ts) degrade to `unknown` and response
// validation has nothing to check against — a silent hole in the contract.
// Non-JSON media types (SSE, binary, HTML) are exempt; fully body-less or
// otherwise justified responses go through the allowlist below.

console.log(`\n  6. Response Schema Presence`);
console.log(`  -----------------------------`);

// "METHOD /path STATUS" entries allowed to omit content/schema, with a reason.
const RESPONSE_SCHEMA_ALLOWLIST = new Set<string>([
  // OAuth/OIDC discovery metadata — shape owned by Better Auth, not consumed
  // by the SPA's typed client.
  "GET /.well-known/oauth-authorization-server 200",
  "GET /.well-known/openid-configuration 200",
  // RFC 8414 path-inserted variants — same Better-Auth-owned document, served
  // for clients that derive the discovery URL from the `${APP_URL}/api/auth`
  // issuer path (e.g. the Claude MCP SDK).
  "GET /.well-known/oauth-authorization-server/api/auth 200",
  "GET /.well-known/openid-configuration/api/auth 200",
  "GET /api/auth/oauth2/authorize 200",
  "GET /api/auth/oauth2/userinfo 200",
  "POST /api/auth/oauth2/revoke 200",
  // Redirect endpoint — the 200 is a degenerate no-body fallback (the real path
  // is a 302); logout always redirects, so there is no body to declare.
  "GET /api/oauth/logout 200",
  // Server-rendered HTML pages (device-flow activation, OAuth callback).
  "GET /activate 200",
  "POST /activate/approve 200",
  "POST /activate/deny 200",
  "GET /api/integrations/callback 200",
  // The three `/api/llm-proxy/*` 200s used to sit here, on the reasoning that a
  // verbatim upstream passthrough "has no stable schema to declare". It does:
  // `openapi/paths/llm-proxy.ts` declares a permissive `{ type: "object",
  // additionalProperties: true }` passthrough schema explicitly to satisfy this
  // very check, and says so in a comment. Two files asserted opposite things
  // about the same three endpoints, and the exemption won by short-circuiting.
]);

const JSON_MEDIA_TYPE = /^application\/([a-z0-9.+-]+\+)?json$/;

const schemaGaps: string[] = [];
// Every 2xx-non-204 response key this step considered, allowlisted or not —
// the domain RESPONSE_SCHEMA_ALLOWLIST is allowed to name. Collected here
// rather than re-walked afterwards so the "which responses does this step
// judge" predicate exists once.
const consideredResponses = new Set<string>();
for (const [specPath, pathItem] of Object.entries(
  openApiSpec.paths as Record<string, Record<string, unknown>>,
)) {
  for (const verb of ROUTE_VERBS) {
    const op = (pathItem as Record<string, unknown>)[verb] as Record<string, unknown> | undefined;
    if (!op || typeof op !== "object") continue;
    const responses = (op.responses ?? {}) as Record<string, unknown>;
    for (const [status, rawResp] of Object.entries(responses)) {
      if (!/^2\d\d$/.test(status) || status === "204") continue;
      const key = `${verb.toUpperCase()} ${specPath} ${status}`;
      consideredResponses.add(key);
      if (RESPONSE_SCHEMA_ALLOWLIST.has(key)) continue;

      let resp = rawResp as Record<string, unknown>;
      if (typeof resp.$ref === "string") {
        resp = resolveRef(resp.$ref) ?? {};
      }
      const content = resp.content as Record<string, Record<string, unknown>> | undefined;
      if (!content || Object.keys(content).length === 0) {
        schemaGaps.push(`${key} — no content declared (use 204 if truly body-less)`);
        continue;
      }
      for (const [mediaType, media] of Object.entries(content)) {
        if (!JSON_MEDIA_TYPE.test(mediaType)) continue;
        if (!media || typeof media.schema !== "object" || media.schema === null) {
          schemaGaps.push(`${key} — ${mediaType} has no schema`);
        }
      }
    }
  }
}

// RESPONSE_SCHEMA_ALLOWLIST was the last hand-maintained exemption list in this
// file without a staleness assertion — §4b's EXEMPT_REQUEST_BODIES, §5b's two
// endpoint allowlists and §7's EXEMPT_SCHEMAS all carry one, for the reason §5b
// states outright: an exemption that no longer applies is the failure mode. An
// entry naming a response the spec no longer serves is not inert, it is a
// pre-authorised hole waiting for the path to come back schema-less. (The only
// list still exempt from this is ERROR_STATUS_ALLOWLIST, deliberately empty.)
const staleResponseSchema = [...RESPONSE_SCHEMA_ALLOWLIST]
  .filter((key) => !consideredResponses.has(key))
  .sort();

if (schemaGaps.length === 0 && staleResponseSchema.length === 0) {
  console.log(
    `  OK — every 2xx JSON response declares a schema (allowlist: ${RESPONSE_SCHEMA_ALLOWLIST.size}, all live).`,
  );
} else {
  exitCode = 1;
  if (schemaGaps.length > 0) {
    console.log(`\n  2xx responses without a schema (${schemaGaps.length}):`);
    for (const gap of schemaGaps.sort()) console.log(`    - ${gap}`);
    console.log(
      `\n  Declare a response schema in apps/api/src/openapi/paths/, switch the ` +
        `response to 204, or add a justified entry to RESPONSE_SCHEMA_ALLOWLIST in this file.`,
    );
  }
  if (staleResponseSchema.length > 0) {
    console.log(
      `\n  Stale RESPONSE_SCHEMA_ALLOWLIST entries — the spec declares no such ` +
        `2xx response any more (${staleResponseSchema.length}):`,
    );
    for (const key of staleResponseSchema) console.log(`    - ${key}`);
    console.log(
      `\n  Delete the stale entries. An exemption that outlives its response pre-approves ` +
        `a schema-less body the day that path returns.`,
    );
  }
}

// ═══════════════════════════════════════════════════
// 7. Shared-Type ↔ OpenAPI Response Required-Field Comparison
// ═══════════════════════════════════════════════════
//
// Asserts the spec and the shared-type agree on which response fields are
// guaranteed. Both directions are drift, for different reasons:
//
//   spec-optional + type-required — the SPA trusts the generated type and reads
//     the field unconditionally, but the spec permits the server to omit it.
//     Exceptions: KNOWN_DRIFT.
//   spec-required + type-optional — the server always sends the field, so this
//     is invisible on the wire, but the type is the record consumers read and a
//     `?` invites a `?? fallback` branch for a case that cannot happen. This is
//     how ResolvedRunConfig came to carry a "compatibility with older servers"
//     tolerance against a CLI with no version negotiation.
//     Exceptions: KNOWN_REVERSE_DRIFT.
//
// Both are restricted to fields the spec declares as properties; the reverse
// direction is further restricted to fields the TYPE declares (with `?`), so a
// type that models a subset of the wire is never reported.

console.log(`\n  7. Shared-Type <> OpenAPI Response Required-Field Comparison`);
console.log(`  ------------------------------------------------------------`);

interface ResponseDrift {
  description: string;
  issues: string[];
}

const responseDrifts: ResponseDrift[] = [];
/** Accepted-divergence entries that suppressed nothing — see `DriftExemptions.used`. */
const deadExemptions: string[] = [];
let responseCompared = 0;

for (const entry of responseTypeRegistry) {
  // Resolve the spec schema (named component or inline response).
  let specSchema: Record<string, unknown> | undefined;
  let driftKey: string;

  if (entry.specSchemaName) {
    driftKey = entry.specSchemaName;
    specSchema = (openApiSpec.components.schemas as Record<string, Record<string, unknown>>)[
      entry.specSchemaName
    ];
  } else if (entry.path && entry.method && entry.status) {
    driftKey = entry.path;
    const pathObj = (openApiSpec.paths as Record<string, Record<string, unknown>>)[entry.path];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const op = pathObj?.[entry.method.toLowerCase()] as any;
    let resp = op?.responses?.[entry.status] as Record<string, unknown> | undefined;
    if (resp && typeof resp.$ref === "string") resp = resolveRef(resp.$ref);
    let schema = (resp?.content as Record<string, Record<string, unknown>> | undefined)?.[
      "application/json"
    ]?.schema as Record<string, unknown> | undefined;
    if (schema && typeof schema.$ref === "string") schema = resolveRef(schema.$ref);
    specSchema = schema;
  } else {
    responseDrifts.push({
      description: entry.description,
      issues: [
        `Invalid registry entry: needs either specSchemaName or path+method+status (sharedType=${entry.sharedTypeName})`,
      ],
    });
    continue;
  }

  if (!specSchema) {
    responseDrifts.push({
      description: entry.description,
      issues: [`No OpenAPI response schema resolved (sharedType=${entry.sharedTypeName})`],
    });
    continue;
  }

  // Resolve the shared-type's recursive shape (nested objects + array elements).
  let shape: TypeShape;
  try {
    shape = getTypeShape(entry.sharedTypeName);
  } catch (err) {
    responseDrifts.push({
      description: entry.description,
      issues: [`Failed to resolve shared type "${entry.sharedTypeName}": ${String(err)}`],
    });
    continue;
  }

  const exempt: DriftExemptions = {
    forward: new Set<string>(KNOWN_DRIFT[driftKey] ?? []),
    reverse: new Set<string>(KNOWN_REVERSE_DRIFT[driftKey] ?? []),
    used: { forward: new Set<string>(), reverse: new Set<string>() },
  };

  responseCompared++;
  const issues: string[] = [];
  compareShapeToSchema(shape, specSchema, "", exempt, issues);

  for (const [register, listed, used] of [
    ["KNOWN_DRIFT", exempt.forward, exempt.used.forward],
    ["KNOWN_REVERSE_DRIFT", exempt.reverse, exempt.used.reverse],
  ] as const) {
    for (const field of listed) {
      if (used.has(field)) continue;
      deadExemptions.push(`${register}["${driftKey}"] → "${field}"`);
    }
  }

  if (issues.length > 0) {
    responseDrifts.push({ description: entry.description, issues });
  }
}

console.log(`  Compared: ${responseCompared}/${responseTypeRegistry.length} registry entries\n`);

if (responseDrifts.length === 0) {
  console.log(
    `  OK — every registered response schema and its shared-type agree on which ` +
      `fields are guaranteed (compared both directions).`,
  );
} else {
  exitCode = 1;
  console.log(`  ${responseDrifts.length} entry(ies) with required-field drift:\n`);
  for (const d of responseDrifts) {
    console.log(`  ERROR  ${d.description}`);
    for (const issue of d.issues) {
      console.log(`          - ${issue}`);
    }
    console.log();
  }
  console.log(
    `  "OpenAPI=optional": tighten the spec response schema's required array, or ` +
      `record the divergence in KNOWN_DRIFT.\n` +
      `  "shared-type=optional": drop the \`?\` in @appstrate/shared-types (and the ` +
      `now-dead null-guards it invited), or record it in KNOWN_REVERSE_DRIFT.\n` +
      `  Both registers live in apps/api/src/openapi/response-type-registry.ts and ` +
      `each entry must carry its justification.`,
  );
}

// Liveness of the two accepted-divergence registers — the same discipline the
// checks around it already apply to their own exemptions (`EXEMPT_SCHEMAS`
// below, `GRANDFATHERED` in scripts/verify-no-migration-dml.ts): an exemption
// that names nothing silently excuses whatever lands at that name tomorrow.
// Two ways to name nothing, and neither is visible without this:
//
//   - a KEY no registry entry resolves to — the schema was renamed, or the
//     entry it belonged to was removed. Nothing ever reads the list under it;
//   - a FIELD that suppressed no finding — it left the type, or the divergence
//     was fixed. The justification beside it now describes nothing.
//
// The pair is deliberately stricter than `GRANDFATHERED`, which checks
// existence only; `DriftExemptions.used` states why the two calls differ.
{
  const registryKeys = new Set(
    responseTypeRegistry
      .map((e) => e.specSchemaName ?? e.path)
      .filter((k): k is string => k !== undefined),
  );
  const orphanKeys = [
    ...Object.keys(KNOWN_DRIFT).map((k) => [`KNOWN_DRIFT`, k] as const),
    ...Object.keys(KNOWN_REVERSE_DRIFT).map((k) => [`KNOWN_REVERSE_DRIFT`, k] as const),
  ]
    .filter(([, key]) => !registryKeys.has(key))
    .map(([register, key]) => `${register}["${key}"] — no responseTypeRegistry entry`);

  const dead = [...orphanKeys, ...deadExemptions].sort();
  if (dead.length > 0) {
    exitCode = 1;
    console.log(`\n  ${dead.length} accepted-divergence entr(y|ies) that excuse nothing:\n`);
    for (const d of dead) console.log(`  ERROR  ${d}`);
    console.log(
      `\n  Delete each one. The drift it recorded is gone (or the field/schema is), ` +
        `so the entry now\n  pre-approves whatever lands at that name next. ` +
        `apps/api/src/openapi/response-type-registry.ts.`,
    );
  }
}

/**
 * How many 2xx JSON responses name their schema, and how many inline it.
 *
 * Printed by §7b so the size of its blind spot is a measurement on every run,
 * not a sentence someone has to keep true by hand.
 */
function countJsonResponseSchemaShapes(): { inline: number; named: number } {
  let inline = 0;
  let named = 0;
  const paths = (openApiSpec.paths ?? {}) as Record<string, Record<string, unknown>>;
  for (const methods of Object.values(paths)) {
    for (const op of Object.values(methods)) {
      const responses = (op as { responses?: Record<string, unknown> })?.responses;
      if (!responses) continue;
      for (const [status, resp] of Object.entries(responses)) {
        if (!status.startsWith("2")) continue;
        const schema = (resp as { content?: Record<string, { schema?: Record<string, unknown> }> })
          ?.content?.["application/json"]?.schema;
        if (!schema || typeof schema !== "object") continue;
        if (typeof schema.$ref === "string") named++;
        else inline++;
      }
    }
  }
  return { inline, named };
}

// Coverage enforcement — every NAMED component schema must be either registered
// (a shared-type pair, checked above) or explicitly EXEMPT (no shared-type
// consumer). Requiring an explicit, justified decision for every named schema
// closes the opt-in gap: one nobody registers is no longer silently uncompared.
//
// WHAT THIS DOES NOT COVER, and it is the majority. The universe is
// `components.schemas` — schemas with a NAME. A 2xx response whose schema is
// written INLINE at the operation has no name, so it is not in that universe
// and no amount of registry discipline reaches it. The count is printed below
// on every run rather than asserted here in prose, because prose is what went
// stale: this block used to claim "step 7 is fail-closed: a new response schema
// can't slip in unchecked", which is true only of the named third.
//
// Closing it needs a different shape — a registry keyed on
// `(verb, path, status)` like §4b's request-body one, not on schema name. That
// is a project, not a tightening, and it is deliberately not attempted here.
{
  const registeredSpecNames = new Set(
    responseTypeRegistry.map((e) => e.specSchemaName).filter((n): n is string => !!n),
  );
  const allSchemaNames = Object.keys(
    (openApiSpec.components.schemas ?? {}) as Record<string, unknown>,
  );
  const uncovered = allSchemaNames
    .filter((n) => !registeredSpecNames.has(n) && !(n in EXEMPT_SCHEMAS))
    .sort();
  // A stale EXEMPT entry (schema renamed/removed) is also a failure — keep the
  // list honest.
  const staleExempt = Object.keys(EXEMPT_SCHEMAS)
    .filter((n) => !allSchemaNames.includes(n))
    .sort();

  console.log(`\n  7b. Step 7 coverage (every component schema registered or exempt)`);
  console.log(`  ----------------------------------------------------------------`);
  if (uncovered.length === 0 && staleExempt.length === 0) {
    console.log(
      `  OK — all ${allSchemaNames.length} component schemas are registered ` +
        `(${registeredSpecNames.size}) or exempt (${Object.keys(EXEMPT_SCHEMAS).length}).`,
    );
    const { inline, named } = countJsonResponseSchemaShapes();
    console.log(
      `  Out of scope: ${inline} of ${inline + named} 2xx JSON responses declare their ` +
        `schema INLINE (no name), so this step cannot see them. See the note above.`,
    );
  } else {
    exitCode = 1;
    if (uncovered.length > 0) {
      console.log(`  Component schema(s) neither registered nor exempt (${uncovered.length}):`);
      for (const n of uncovered) console.log(`    - ${n}`);
      console.log(
        `\n  Add each to responseTypeRegistry (with its shared-type) or to ` +
          `EXEMPT_SCHEMAS (with a reason) in apps/api/src/openapi/response-type-registry.ts.`,
      );
    }
    if (staleExempt.length > 0) {
      console.log(`\n  Stale EXEMPT_SCHEMAS entries (schema no longer exists):`);
      for (const n of staleExempt) console.log(`    - ${n}`);
    }
  }
}

// ═══════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════

console.log(`  ${"=".repeat(50)}`);
console.log(`  ${exitCode === 0 ? "ALL CHECKS PASSED" : "SOME CHECKS FAILED"}`);
console.log(`  ${"=".repeat(50)}\n`);

process.exit(exitCode);
