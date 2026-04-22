// SPDX-License-Identifier: Apache-2.0

/**
 * Verify OpenAPI spec: completeness, structural validity, best practices,
 * and Zod ↔ OpenAPI request-body schema consistency.
 *
 * 1. Endpoint coverage — compares spec vs maintained endpoint list
 * 2. Structural validation — @readme/openapi-parser (OpenAPI 3.1 schema conformance)
 * 3. Best practices lint — @redocly/openapi-core (recommended ruleset)
 * 4. Zod ↔ OpenAPI schema comparison — compares Zod-derived JSON Schemas (pre-converted
 *    in the registry via z.toJSONSchema()) against hand-written OpenAPI requestBody schemas
 *
 * Module-owned paths and schemas are loaded dynamically from built-in modules.
 * The set of modules validated matches `MODULES` (default: all built-in).
 *
 * Usage: bun scripts/verify-openapi.ts
 */
import { validate as validateOpenAPI } from "@readme/openapi-parser";
import { lintFromString, createConfig } from "@redocly/openapi-core";
import { buildOpenApiSpec } from "../apps/api/src/openapi/index.ts";
import {
  buildZodSchemaRegistry,
  type ZodSchemaEntry,
} from "../apps/api/src/openapi/zod-schema-registry.ts";
import { collectModuleOpenApi } from "./lib/module-openapi.ts";

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
// 1. Endpoint coverage
// ═══════════════════════════════════════════════════

const expectedEndpoints = [
  // Health
  "GET /health",

  // Auth (Better Auth)
  "POST /api/auth/sign-up/email",
  "POST /api/auth/sign-in/email",
  "POST /api/auth/sign-out",
  "GET /api/auth/get-session",

  // Agents (runtime — agents.ts + user-agents.ts junction endpoints)
  "GET /api/agents",
  "PUT /api/agents/{scope}/{name}/config",
  "GET /api/agents/{scope}/{name}/memories",
  "DELETE /api/agents/{scope}/{name}/memories",
  "DELETE /api/agents/{scope}/{name}/memories/{memoryId}",
  "PUT /api/agents/{scope}/{name}/skills",
  "PUT /api/agents/{scope}/{name}/tools",
  "GET /api/agents/{scope}/{name}/model",
  "PUT /api/agents/{scope}/{name}/model",
  "GET /api/agents/{scope}/{name}/bundle",

  // Runs
  "POST /api/agents/{scope}/{name}/run",
  "GET /api/agents/{scope}/{name}/runs",
  "DELETE /api/agents/{scope}/{name}/runs",
  "GET /api/runs/{id}",
  "GET /api/runs/{id}/logs",
  "POST /api/runs/{id}/cancel",

  // Realtime (SSE)
  "GET /api/realtime/runs",
  "GET /api/realtime/runs/{id}",
  "GET /api/realtime/agents/{packageId}/runs",

  // Schedules
  "GET /api/schedules",
  "GET /api/schedules/{id}",
  "GET /api/schedules/{id}/runs",
  "GET /api/agents/{scope}/{name}/schedules",
  "POST /api/agents/{scope}/{name}/schedules",
  "PUT /api/schedules/{id}",
  "DELETE /api/schedules/{id}",

  // Connections
  "GET /api/connections",
  "GET /api/connections/integrations",
  "POST /api/connections/connect/{scope}/{name}",
  "POST /api/connections/connect/{scope}/{name}/api-key",
  "POST /api/connections/connect/{scope}/{name}/credentials",
  "GET /api/connections/callback",
  "DELETE /api/connections/{scope}/{name}",

  // Providers
  "GET /api/providers",
  "POST /api/providers",
  "PUT /api/providers/{scope}/{name}",
  "DELETE /api/providers/{scope}/{name}",

  // Provider Credentials
  "PUT /api/providers/credentials/{scope}/{name}",
  "DELETE /api/providers/credentials/{scope}/{name}",

  // Connection Profiles (org-scoped user profiles)
  "GET /api/connection-profiles",
  "POST /api/connection-profiles",
  "PUT /api/connection-profiles/{id}",
  "DELETE /api/connection-profiles/{id}",

  // App Profiles (app-scoped)
  "GET /api/app-profiles",
  "POST /api/app-profiles",
  "GET /api/app-profiles/connections",
  "DELETE /api/app-profiles/connections",
  "GET /api/app-profiles/my-bindings",
  "PUT /api/app-profiles/{id}",
  "DELETE /api/app-profiles/{id}",
  "GET /api/app-profiles/{id}/agents",
  "GET /api/app-profiles/{id}/bindings",
  "POST /api/app-profiles/{id}/bind",
  "DELETE /api/app-profiles/{id}/bind/{providerScope}/{providerName}",
  "GET /api/app-profiles/{id}/connections",

  // Agent Provider Profiles
  "GET /api/agents/{scope}/{name}/provider-profiles",
  "PUT /api/agents/{scope}/{name}/provider-profiles",
  "DELETE /api/agents/{scope}/{name}/provider-profiles",

  // Agent App Profile
  "PUT /api/agents/{scope}/{name}/app-profile",

  // Agent Proxy
  "GET /api/agents/{scope}/{name}/proxy",
  "PUT /api/agents/{scope}/{name}/proxy",

  // Provider Keys
  "GET /api/provider-keys",
  "POST /api/provider-keys",
  "POST /api/provider-keys/test",
  "PUT /api/provider-keys/{id}",
  "DELETE /api/provider-keys/{id}",
  "POST /api/provider-keys/{id}/test",

  // Models
  "GET /api/models",
  "POST /api/models",
  "PUT /api/models/default",
  "GET /api/models/openrouter",
  "POST /api/models/test",
  "PUT /api/models/{id}",
  "DELETE /api/models/{id}",
  "POST /api/models/{id}/test",

  // Proxies
  "GET /api/proxies",
  "POST /api/proxies",
  "PUT /api/proxies/default",
  "PUT /api/proxies/{id}",
  "DELETE /api/proxies/{id}",
  "POST /api/proxies/{id}/test",

  // API Keys
  "GET /api/api-keys/available-scopes",
  "GET /api/api-keys",
  "POST /api/api-keys",
  "DELETE /api/api-keys/{id}",

  // Packages — Skills
  "GET /api/packages/skills",
  "POST /api/packages/skills",
  "GET /api/packages/skills/{scope}/{name}",
  "PUT /api/packages/skills/{scope}/{name}",
  "DELETE /api/packages/skills/{scope}/{name}",
  "GET /api/packages/skills/{id}",
  "PUT /api/packages/skills/{id}",
  "DELETE /api/packages/skills/{id}",
  "GET /api/packages/skills/{scope}/{name}/versions",
  "GET /api/packages/skills/{scope}/{name}/versions/info",
  "POST /api/packages/skills/{scope}/{name}/versions",
  "POST /api/packages/skills/{scope}/{name}/versions/{version}/restore",
  "DELETE /api/packages/skills/{scope}/{name}/versions/{version}",
  "GET /api/packages/skills/{scope}/{name}/versions/{version}",

  // Packages — Tools
  "GET /api/packages/tools",
  "POST /api/packages/tools",
  "GET /api/packages/tools/{scope}/{name}",
  "PUT /api/packages/tools/{scope}/{name}",
  "DELETE /api/packages/tools/{scope}/{name}",
  "GET /api/packages/tools/{id}",
  "PUT /api/packages/tools/{id}",
  "DELETE /api/packages/tools/{id}",
  "GET /api/packages/tools/{scope}/{name}/versions",
  "GET /api/packages/tools/{scope}/{name}/versions/info",
  "POST /api/packages/tools/{scope}/{name}/versions",
  "POST /api/packages/tools/{scope}/{name}/versions/{version}/restore",
  "DELETE /api/packages/tools/{scope}/{name}/versions/{version}",
  "GET /api/packages/tools/{scope}/{name}/versions/{version}",

  // Packages — Providers (package CRUD)
  "GET /api/packages/providers",
  "POST /api/packages/providers",
  "GET /api/packages/providers/{scope}/{name}",
  "PUT /api/packages/providers/{scope}/{name}",
  "DELETE /api/packages/providers/{scope}/{name}",
  "GET /api/packages/providers/{id}",
  "PUT /api/packages/providers/{id}",
  "DELETE /api/packages/providers/{id}",
  "GET /api/packages/providers/{scope}/{name}/versions",
  "GET /api/packages/providers/{scope}/{name}/versions/info",
  "POST /api/packages/providers/{scope}/{name}/versions",
  "POST /api/packages/providers/{scope}/{name}/versions/{version}/restore",
  "DELETE /api/packages/providers/{scope}/{name}/versions/{version}",
  "GET /api/packages/providers/{scope}/{name}/versions/{version}",

  // Packages — Agents
  "GET /api/packages/agents",
  "POST /api/packages/agents",
  "GET /api/packages/agents/{scope}/{name}",
  "PUT /api/packages/agents/{scope}/{name}",
  "DELETE /api/packages/agents/{scope}/{name}",
  "GET /api/packages/agents/{id}",
  "PUT /api/packages/agents/{id}",
  "DELETE /api/packages/agents/{id}",
  "GET /api/packages/agents/{scope}/{name}/versions",
  "GET /api/packages/agents/{scope}/{name}/versions/info",
  "POST /api/packages/agents/{scope}/{name}/versions",
  "POST /api/packages/agents/{scope}/{name}/versions/{version}/restore",
  "DELETE /api/packages/agents/{scope}/{name}/versions/{version}",
  "GET /api/packages/agents/{scope}/{name}/versions/{version}",

  // Organizations
  "GET /api/orgs",
  "POST /api/orgs",
  "GET /api/orgs/{orgId}",
  "PUT /api/orgs/{orgId}",
  "DELETE /api/orgs/{orgId}",
  "POST /api/orgs/{orgId}/members",
  "PUT /api/orgs/{orgId}/members/{userId}",
  "DELETE /api/orgs/{orgId}/members/{userId}",
  "PUT /api/orgs/{orgId}/invitations/{invitationId}",
  "DELETE /api/orgs/{orgId}/invitations/{invitationId}",

  // Profile
  "GET /api/profile",
  "PATCH /api/profile",
  "POST /api/profiles/batch",
  "GET /api/me/orgs",
  "GET /api/me/models",

  // Invitations
  "GET /invite/{token}/info",
  "POST /invite/{token}/accept",

  // Welcome
  "POST /api/welcome/setup",

  // Internal
  "GET /internal/run-history",
  "GET /internal/credentials/{scope}/{name}",
  "POST /internal/credentials/{scope}/{name}/refresh",
  "POST /internal/connections/report-auth-failure",

  // Meta
  "GET /api/openapi.json",
  "GET /api/docs",

  // Notifications
  "GET /api/notifications/unread-count",
  "GET /api/notifications/unread-counts-by-agent",
  "PUT /api/notifications/read/{runId}",
  "PUT /api/notifications/read-all",
  "GET /api/runs",
  "POST /api/runs/inline",
  "POST /api/runs/inline/validate",

  // Packages
  "POST /api/packages/import",
  "POST /api/packages/import-github",
  "GET /api/packages/{scope}/{name}/{version}/download",
  "POST /api/packages/{scope}/{name}/fork",

  // Organization settings
  "GET /api/orgs/{orgId}/settings",
  "PUT /api/orgs/{orgId}/settings",

  // Applications
  "POST /api/applications",
  "GET /api/applications",
  "GET /api/applications/{id}",
  "PATCH /api/applications/{id}",
  "DELETE /api/applications/{id}",

  // Application Packages
  "GET /api/applications/{appId}/packages",
  "POST /api/applications/{appId}/packages",
  "GET /api/applications/{appId}/packages/{scope}/{name}",
  "PUT /api/applications/{appId}/packages/{scope}/{name}",
  "DELETE /api/applications/{appId}/packages/{scope}/{name}",

  // Application Providers
  "GET /api/applications/{appId}/providers",
  "PUT /api/applications/{appId}/providers/{scope}/{name}/credentials",
  "DELETE /api/applications/{appId}/providers/{scope}/{name}/credentials",

  // End-Users
  "POST /api/end-users",
  "GET /api/end-users",
  "GET /api/end-users/{id}",
  "PATCH /api/end-users/{id}",
  "DELETE /api/end-users/{id}",

  // Uploads
  "POST /api/uploads",
  "PUT /api/uploads/_content",

  // Credential proxy (AFPS 1.3 BYOI)
  "POST /api/credential-proxy/proxy",
];

// Module-contributed endpoints are sourced directly from each module's
// `openApiPaths()` output — no hardcoded list. This keeps verify-openapi
// in sync with whatever the module declares, so adding or removing a
// module endpoint requires no update here.
for (const [path, methods] of Object.entries(modulePaths)) {
  if (!methods || typeof methods !== "object") continue;
  for (const method of Object.keys(methods as Record<string, unknown>)) {
    // Skip OpenAPI path-level fields that aren't HTTP methods (parameters, summary, etc.)
    const lower = method.toLowerCase();
    if (!["get", "post", "put", "patch", "delete", "head", "options"].includes(lower)) continue;
    expectedEndpoints.push(`${lower.toUpperCase()} ${path}`);
  }
}

const specEndpoints = new Set<string>();
const paths = openApiSpec.paths as Record<string, Record<string, unknown>>;
for (const [path, methods] of Object.entries(paths)) {
  for (const method of Object.keys(methods)) {
    specEndpoints.add(`${method.toUpperCase()} ${path}`);
  }
}

const missing: string[] = [];
const obsolete: string[] = [];

for (const ep of expectedEndpoints) {
  if (!specEndpoints.has(ep)) missing.push(ep);
}
for (const ep of specEndpoints) {
  if (!expectedEndpoints.includes(ep)) obsolete.push(ep);
}

console.log(`\n  1. Endpoint Coverage`);
console.log(`  --------------------`);
console.log(`  Spec: ${specEndpoints.size}  Expected: ${expectedEndpoints.length}`);

if (missing.length === 0 && obsolete.length === 0) {
  console.log(`  OK — all endpoints accounted for.`);
} else {
  exitCode = 1;
  if (missing.length > 0) {
    console.log(`\n  MISSING from spec (${missing.length}):`);
    for (const ep of missing) console.log(`    - ${ep}`);
  }
  if (obsolete.length > 0) {
    console.log(`\n  IN SPEC but not expected (${obsolete.length}):`);
    for (const ep of obsolete) console.log(`    - ${ep}`);
  }
}

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

/**
 * Extract the request-body JSON Schema from the OpenAPI spec for a given path+method.
 * Returns undefined if the endpoint has no requestBody or no application/json content.
 * Resolves top-level `$ref` pointers so the comparison gets the actual schema.
 */
function getOpenApiRequestBodySchema(
  specPath: string,
  method: string,
): Record<string, unknown> | undefined {
  const pathObj = (openApiSpec.paths as Record<string, Record<string, unknown>>)[specPath];
  if (!pathObj) return undefined;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const operation = pathObj[method.toLowerCase()] as any;
  if (!operation?.requestBody) return undefined;

  let schema = operation.requestBody?.content?.["application/json"]?.schema as
    | Record<string, unknown>
    | undefined;

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
  if (schema.anyOf && Array.isArray(schema.anyOf)) {
    // Zod emits anyOf for nullable: [{ type: "string", ... }, { type: "null" }]
    const types: string[] = [];
    let nullable = false;
    for (const variant of schema.anyOf as Record<string, unknown>[]) {
      if (variant.type === "null") {
        nullable = true;
      } else if (typeof variant.type === "string") {
        types.push(variant.type);
      }
    }
    return { baseTypes: types.sort(), nullable };
  }

  if (Array.isArray(schema.type)) {
    // OpenAPI style: type: ["string", "null"]
    const types = (schema.type as string[]).filter((t) => t !== "null").sort();
    const nullable = (schema.type as string[]).includes("null");
    return { baseTypes: types, nullable };
  }

  if (typeof schema.type === "string") {
    return { baseTypes: [schema.type], nullable: false };
  }

  return { baseTypes: [], nullable: false };
}

interface SchemaDiscrepancy {
  entry: ZodSchemaEntry;
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

    // String constraints — maxLength (check anyOf variants for Zod nullable types)
    const zodMaxLen =
      zodProp.maxLength ??
      (zodProp.anyOf as Record<string, unknown>[] | undefined)?.find((v) => v.maxLength)?.maxLength;
    const oaMaxLen = oaProp.maxLength;
    if (zodMaxLen !== undefined && oaMaxLen !== undefined && zodMaxLen !== oaMaxLen) {
      issues.push(`Property "${field}" maxLength: Zod=${zodMaxLen}, OpenAPI=${oaMaxLen}`);
    }
    if (zodMaxLen !== undefined && oaMaxLen === undefined) {
      issues.push(`Property "${field}" maxLength: Zod=${zodMaxLen}, OpenAPI=unset`);
    }

    // String constraints — minLength
    const zodMinLen =
      zodProp.minLength ??
      (zodProp.anyOf as Record<string, unknown>[] | undefined)?.find((v) => v.minLength)?.minLength;
    const oaMinLen = oaProp.minLength;
    if (zodMinLen !== undefined && oaMinLen !== undefined && zodMinLen !== oaMinLen) {
      issues.push(`Property "${field}" minLength: Zod=${zodMinLen}, OpenAPI=${oaMinLen}`);
    }
    if (zodMinLen !== undefined && oaMinLen === undefined) {
      issues.push(`Property "${field}" minLength: Zod=${zodMinLen}, OpenAPI=unset`);
    }

    // Pattern
    const zodPattern = zodProp.pattern;
    const oaPattern = oaProp.pattern;
    if (zodPattern && oaPattern && zodPattern !== oaPattern) {
      issues.push(`Property "${field}" pattern: Zod="${zodPattern}", OpenAPI="${oaPattern}"`);
    }

    // Format (check anyOf variants for Zod nullable types)
    const zodFormat =
      zodProp.format ??
      (zodProp.anyOf as Record<string, unknown>[] | undefined)?.find((v) => v.format)?.format;
    const oaFormat = oaProp.format;
    if (zodFormat && oaFormat && zodFormat !== oaFormat) {
      issues.push(`Property "${field}" format: Zod="${zodFormat}", OpenAPI="${oaFormat}"`);
    }

    // Enum values (also check inside array items)
    const zodEnum = zodProp.enum ?? (zodProp.items as Record<string, unknown> | undefined)?.enum;
    const oaEnum = oaProp.enum ?? (oaProp.items as Record<string, unknown> | undefined)?.enum;
    if (zodEnum && oaEnum) {
      const zodEnumStr = JSON.stringify([...(zodEnum as unknown[])].sort());
      const oaEnumStr = JSON.stringify([...(oaEnum as unknown[])].sort());
      if (zodEnumStr !== oaEnumStr) {
        issues.push(`Property "${field}" enum: Zod=${zodEnumStr}, OpenAPI=${oaEnumStr}`);
      }
    }

    // Array item type
    if (zodProp.type === "array" && oaProp.type === "array") {
      const zodItems = zodProp.items as Record<string, unknown> | undefined;
      const oaItems = oaProp.items as Record<string, unknown> | undefined;
      if (zodItems?.type && oaItems?.type && zodItems.type !== oaItems.type) {
        issues.push(
          `Property "${field}" array items type: Zod=${zodItems.type}, OpenAPI=${oaItems.type}`,
        );
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

// ═══════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════

console.log(`  ${"=".repeat(50)}`);
console.log(`  ${exitCode === 0 ? "ALL CHECKS PASSED" : "SOME CHECKS FAILED"}`);
console.log(`  ${"=".repeat(50)}\n`);

// @ts-ignore Bun's type definitions for process.exit are incorrect (they say it returns never, but it actually returns void), so we ignore the type error here.
process.exit(exitCode);
