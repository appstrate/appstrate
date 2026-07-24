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
 * 5. Code subset Spec — statically enumerates router.METHOD() and app.METHOD() calls across
 *    apps/api/src/routes (per-domain route files) plus apps/api/src/modules (built-in modules)
 *    plus apps/api/src/index.ts, composes the mount prefix from app.route(prefix, factory) calls,
 *    normalises Hono path syntax, and asserts every code-registered endpoint is documented in
 *    the OpenAPI spec or in the explicit allowlist.
 * 6. Response schema presence — every 2xx JSON response (except 204) must declare a schema
 * 7. Shared-type ↔ OpenAPI response required-field comparison — for each registered
 *    (spec-schema ↔ @appstrate/shared-types interface) pair, asserts every type-required field
 *    is also required in the spec response schema (catches spec-optional / type-required drift)
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
import { buildZodSchemaRegistry } from "../apps/api/src/openapi/zod-schema-registry.ts";
import {
  responseTypeRegistry,
  KNOWN_DRIFT,
  EXEMPT_SCHEMAS,
} from "../apps/api/src/openapi/response-type-registry.ts";
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
  // Bootstrap-token redemption (#344 Layer 2b) — platform-owned, not BA
  "POST /api/auth/bootstrap/redeem",

  // Agents (runtime — agents.ts + user-agents.ts junction endpoints)
  "GET /api/agents",
  "PUT /api/agents/{scope}/{name}/config",
  // Unified persistence — pinned slots + memories
  "GET /api/agents/{scope}/{name}/persistence",
  "DELETE /api/agents/{scope}/{name}/persistence",
  "DELETE /api/agents/{scope}/{name}/persistence/memories/{id}",
  "DELETE /api/agents/{scope}/{name}/persistence/pinned/{id}",
  "PUT /api/agents/{scope}/{name}/skills",
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

  // Integrations (INTEGRATIONS_PROPOSAL Phase 1.3 — marketplace UI)
  "GET /api/integrations",
  "GET /api/integrations/callback",
  "GET /api/integrations/{packageId}",
  "POST /api/integrations/{packageId}/activate",
  "DELETE /api/integrations/{packageId}/deactivate",
  "POST /api/integrations/{packageId}/auths/{authKey}/oauth-clients",
  "PUT /api/integrations/{packageId}/oauth-clients/{clientId}",
  "DELETE /api/integrations/{packageId}/oauth-clients/{clientId}",
  "GET /api/integrations/{packageId}/auths/{authKey}/clients",
  "PUT /api/integrations/{packageId}/auths/{authKey}/default-client",
  "POST /api/integrations/{packageId}/auths/{authKey}/connect/fields",
  "POST /api/integrations/{packageId}/auths/{authKey}/connect/oauth2",
  "POST /api/integrations/{packageId}/auths/{authKey}/connect/session",
  "GET /api/integrations/connect/start",
  "GET /api/integrations/connect/context",
  "POST /api/integrations/connect/submit",
  "GET /api/integrations/{packageId}/connections",
  "GET /api/integrations/{packageId}/consuming-agents",
  "PATCH /api/integrations/{packageId}/connections/{connectionId}",
  "PATCH /api/integrations/{packageId}/settings",
  "GET /api/integrations/{packageId}/pins",
  "PUT /api/integrations/{packageId}/pins/{agentPackageId}",
  "DELETE /api/integrations/{packageId}/pins/{agentPackageId}",
  "GET /api/integrations/{packageId}/default",
  "PUT /api/integrations/{packageId}/default",
  "DELETE /api/integrations/{packageId}/default",

  // Agent Proxy
  "GET /api/agents/{scope}/{name}/proxy",
  "GET /api/agents/{scope}/{name}/connection-readiness",
  "PUT /api/agents/{scope}/{name}/proxy",

  // Model Provider Credentials
  "GET /api/model-provider-credentials/registry",
  "GET /api/model-provider-credentials",
  "POST /api/model-provider-credentials",
  "POST /api/model-provider-credentials/test",
  "PUT /api/model-provider-credentials/{id}",
  "DELETE /api/model-provider-credentials/{id}",
  "POST /api/model-provider-credentials/{id}/test",
  "POST /api/model-provider-credentials/{id}/refresh-models",
  // OAuth Model Providers (subscription billing)
  "POST /api/model-providers-oauth/pair/redeem",
  "POST /api/model-providers-oauth/pairing",
  "GET /api/model-providers-oauth/pairing/{id}",
  "DELETE /api/model-providers-oauth/pairing/{id}",

  // Models
  "GET /api/models",
  "POST /api/models",
  "PUT /api/models/default",
  "GET /api/models/openrouter",
  "POST /api/models/test",
  "POST /api/models/seed",
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

  // Packages — Integrations
  "GET /api/packages/integrations",
  "POST /api/packages/integrations",
  "GET /api/packages/integrations/{scope}/{name}",
  "PUT /api/packages/integrations/{scope}/{name}",
  "DELETE /api/packages/integrations/{scope}/{name}",
  "GET /api/packages/integrations/{id}",
  "PUT /api/packages/integrations/{id}",
  "DELETE /api/packages/integrations/{id}",
  "GET /api/packages/integrations/{scope}/{name}/versions",
  "GET /api/packages/integrations/{scope}/{name}/versions/info",
  "POST /api/packages/integrations/{scope}/{name}/versions",
  "POST /api/packages/integrations/{scope}/{name}/versions/{version}/restore",
  "DELETE /api/packages/integrations/{scope}/{name}/versions/{version}",
  "GET /api/packages/integrations/{scope}/{name}/versions/{version}",

  // Packages — MCP Servers
  "GET /api/packages/mcp-servers",
  "POST /api/packages/mcp-servers",
  "GET /api/packages/mcp-servers/{scope}/{name}",
  "PUT /api/packages/mcp-servers/{scope}/{name}",
  "DELETE /api/packages/mcp-servers/{scope}/{name}",
  "GET /api/packages/mcp-servers/{id}",
  "PUT /api/packages/mcp-servers/{id}",
  "DELETE /api/packages/mcp-servers/{id}",
  "GET /api/packages/mcp-servers/{scope}/{name}/versions",
  "GET /api/packages/mcp-servers/{scope}/{name}/versions/info",
  "POST /api/packages/mcp-servers/{scope}/{name}/versions",
  "POST /api/packages/mcp-servers/{scope}/{name}/versions/{version}/restore",
  "DELETE /api/packages/mcp-servers/{scope}/{name}/versions/{version}",
  "GET /api/packages/mcp-servers/{scope}/{name}/versions/{version}",

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
  "POST /api/profile/password",
  "POST /api/profiles/batch",
  "GET /api/me/orgs",
  "GET /api/me/context",
  "GET /api/me/models",
  "GET /api/me/connections",
  "DELETE /api/me/connections/{connectionId}",
  "GET /api/me/integration-pins",
  "PUT /api/me/integration-pins",
  "DELETE /api/me/integration-pins",

  // Invitations
  "GET /invite/{token}/info",
  "POST /invite/{token}/accept",

  // Welcome
  "POST /api/welcome/setup",

  // Internal
  "GET /internal/run-history",
  "GET /internal/memories",
  "GET /internal/oauth-token/{credentialId}",
  "POST /internal/oauth-token/{credentialId}/refresh",
  "GET /internal/mcp-server-bundle/{scope}/{name}",
  "GET /internal/integration-credentials/{scope}/{name}",
  "POST /internal/integration-credentials/{scope}/{name}/refresh",

  // Meta
  "GET /api/openapi.json",
  "GET /api/docs",

  // Notifications
  "GET /api/notifications",
  "GET /api/notifications/unread-count",
  "GET /api/notifications/unread-counts-by-agent",
  "PUT /api/notifications/{id}/read",
  "PUT /api/notifications/read/{runId}",
  "PUT /api/notifications/read-all",
  "GET /api/runs",
  "POST /api/runs/inline",
  "POST /api/runs/inline/validate",
  "POST /api/runs/remote",
  "POST /api/runs/{runId}/events",
  "POST /api/runs/{runId}/events/finalize",
  "POST /api/runs/{runId}/events/heartbeat",
  "GET /api/runs/{runId}/workspace",
  "GET /api/runs/{runId}/documents",
  "POST /api/runs/{runId}/documents",
  "GET /api/runs/{runId}/documents/{name}",
  "PATCH /api/runs/{runId}/sink/extend",

  // Packages
  "POST /api/packages/import",
  "POST /api/packages/import-github",
  "POST /api/packages/import-bundle",
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
  "GET /api/applications/{applicationId}/packages",
  "POST /api/applications/{applicationId}/packages",
  "GET /api/applications/{applicationId}/packages/{scope}/{name}",
  "PUT /api/applications/{applicationId}/packages/{scope}/{name}",
  "DELETE /api/applications/{applicationId}/packages/{scope}/{name}",
  "GET /api/applications/{applicationId}/packages/{scope}/{name}/run-config",

  // End-Users
  "POST /api/end-users",
  "GET /api/end-users",
  "GET /api/end-users/{id}",
  "PATCH /api/end-users/{id}",
  "DELETE /api/end-users/{id}",

  // Uploads
  "POST /api/uploads",
  "PUT /api/uploads/_content",

  // Documents (durable document store — inputs + agent outputs)
  "GET /api/documents",
  "GET /api/documents/{id}",
  "DELETE /api/documents/{id}",
  "POST /api/documents/{id}/keep",
  "GET /api/documents/{id}/content",

  // Credential proxy (AFPS BYOI) — registered as router.all() in code,
  // every verb is documented because upstream provider semantics are method-defined.
  "GET /api/credential-proxy/proxy",
  "POST /api/credential-proxy/proxy",
  "PUT /api/credential-proxy/proxy",
  "PATCH /api/credential-proxy/proxy",
  "DELETE /api/credential-proxy/proxy",

  // LLM proxy (Remote CLI execution — Phase 3)
  "POST /api/llm-proxy/openai-completions/v1/chat/completions",
  "POST /api/llm-proxy/anthropic-messages/v1/messages",
  "POST /api/llm-proxy/mistral-conversations/v1/chat/completions",

  // Library (consolidated package catalog across an org's applications)
  "GET /api/library",

  // Storage-deletion outbox operator surface (platform-admin gated)
  "GET /api/admin/storage-deletion-jobs",
  "POST /api/admin/storage-deletion-jobs/{id}/retry",
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

/**
 * Recursively compare a shared-type {@link TypeShape} against a spec schema,
 * collecting required-field drift at every nesting level (nested objects and
 * array element types — not just the top level). Recursion descends only where
 * the shared-type exposes a closed nested shape AND the spec side is a closed
 * object; open objects (`additionalProperties:true` / JSONB / Record) short-
 * circuit so dynamic payloads never false-positive.
 */
function compareShapeToSchema(
  shape: TypeShape,
  specSchema: any,
  prefix: string,
  known: Set<string>,
  issues: string[],
  depth = 0,
): void {
  if (depth > 8) return;
  const norm = normalizeSpecSchema(specSchema);
  if (!norm) return;
  const specProps = new Set(Object.keys(norm.properties));
  for (const field of shape.required) {
    const label = prefix ? `${prefix}.${field}` : field;
    if (known.has(label) || (!prefix && known.has(field))) continue;
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
        compareShapeToSchema(childShape, childNorm.items, `${label}[]`, known, issues, depth + 1);
      } else {
        compareShapeToSchema(childShape, norm.properties[field], label, known, issues, depth + 1);
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

    // String/length/format/enum constraint checks below are UNIDIRECTIONAL by
    // design: they flag a constraint present in Zod but missing (or differing)
    // in OpenAPI, not the reverse (OpenAPI-only constraint). Zod is the runtime
    // source of truth, so a Zod constraint absent from the spec is the drift
    // that misleads consumers; the spec legitimately carries descriptive
    // constraints Zod does not enforce. KNOWN LIMITATION: OpenAPI-only
    // constraints therefore go unreported here — tightening to bidirectional
    // would require reconciling that pre-existing hand-authored drift first.
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
//    - Named: `import { createXRouter } from "./routes/x.ts"`
//    - Default: `import xRouter from "./routes/x.ts"`
const importToFile = new Map<string, string>(); // identifier → relative file path
for (const m of indexSrc.matchAll(
  /import\s+\{([^}]+)\}\s+from\s+["']\.\/(routes\/[^"']+?)(?:\.ts)?["']/g,
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
  /import\s+(\w+)\s+from\s+["']\.\/(routes\/[^"']+?)(?:\.ts)?["']/g,
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
  let factory: string | "__default__" = ident;
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

  if (file) mounts.push({ prefix, file, factory });
}

// 4. Discovered code endpoints
const codeEndpoints = new Set<string>();
// "VERB PATH" → error statuses the handler is statically certain to return
// (union across every registration that maps to the same endpoint). Feeds the
// 5b documented-error-status check.
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
const SKIP_FILES = new Set<string>([
  // Routes registered via runtime config with a VARIABLE path
  // (`router.post(entry.urlPath, …)` — a bare identifier, not a string/template
  // literal). The path can't be captured at all, so the emitted endpoints are
  // covered by check #1. (packages.ts is NOT skipped: its template-literal
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

// Meta-guard: a whole-file skip lets every endpoint in that file escape the
// Code ⊆ Spec check (above), so adding one must be a deliberate, reviewed act.
// Sanctioned skips: `routes/llm-proxy` (variable-path config loop) and the
// firecracker runner daemon server (standalone process, not platform API).
// If anyone widens this set, fail loudly here and force per-route handling or
// an explicit, justified decision instead of a silent coverage hole.
const ALLOWED_SKIP_FILES = new Set<string>([
  "routes/llm-proxy",
  "modules/firecracker/runner/server",
]);
const unexpectedSkips = [...SKIP_FILES].filter((f) => !ALLOWED_SKIP_FILES.has(f));
if (SKIP_FILES.size > ALLOWED_SKIP_FILES.size || unexpectedSkips.length > 0) {
  exitCode = 1;
  console.log(`\n  5. Code ⊆ Spec — SKIP_FILES guard`);
  console.log(`  ---------------------------------`);
  console.log(
    `  ERROR  SKIP_FILES must contain only the sanctioned whole-file skip ` +
      `(${[...ALLOWED_SKIP_FILES].join(", ")}).`,
  );
  if (unexpectedSkips.length > 0) {
    console.log(`  Unexpected skip(s) that would hide endpoints from the Code ⊆ Spec check:`);
    for (const f of unexpectedSkips) console.log(`    - ${f}`);
  }
  console.log(
    `\n  A whole-file skip silently excludes every route in that file. Don't widen ` +
      `SKIP_FILES — verify the file's literal-path routes against the spec individually, ` +
      `or, if a skip is genuinely unavoidable, add the file to ALLOWED_SKIP_FILES in this ` +
      `file with a justifying comment so the decision is reviewed.`,
  );
}

const routeFileCache = new Map<string, string>();
function readRouteFile(relPath: string): string {
  const cached = routeFileCache.get(relPath);
  if (cached !== undefined) return cached;
  const full = join(REPO_ROOT, "apps/api/src", relPath + ".ts");
  const src = existsSync(full) ? readFileSync(full, "utf8") : "";
  routeFileCache.set(relPath, src);
  return src;
}

for (const mount of mounts) {
  if (SKIP_FILES.has(mount.file)) continue;
  const src = readRouteFile(mount.file);
  if (!src) continue;

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
      // Same sanctioned whole-file skip as 4b (guarded by ALLOWED_SKIP_FILES).
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
  // Cookie-less HTML document preview — serves untrusted agent HTML (text/html)
  // from a hardened, session-less route OUTSIDE /api, authorized by a signed
  // token in the URL. Not a JSON API endpoint; intentionally undocumented in the
  // OpenAPI surface (no typed client, no SDK consumer).
  "GET /preview/documents/{id}",
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
    `\n  Either document the endpoint in apps/api/src/openapi/paths/ + add it to ` +
      `expectedEndpoints, or add a justified entry to CODE_TO_SPEC_ALLOWLIST in this file.`,
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
// 5b. Documented error statuses
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

console.log(`\n  5b. Documented Error Statuses`);
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
  // LLM proxy passthrough — the body is the upstream provider's response,
  // verbatim; there is no stable schema to declare.
  "POST /api/llm-proxy/anthropic-messages/v1/messages 200",
  "POST /api/llm-proxy/mistral-conversations/v1/chat/completions 200",
  "POST /api/llm-proxy/openai-completions/v1/chat/completions 200",
]);

const JSON_MEDIA_TYPE = /^application\/([a-z0-9.+-]+\+)?json$/;

const schemaGaps: string[] = [];
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

if (schemaGaps.length === 0) {
  console.log(
    `  OK — every 2xx JSON response declares a schema (allowlist: ${RESPONSE_SCHEMA_ALLOWLIST.size}).`,
  );
} else {
  exitCode = 1;
  console.log(`\n  2xx responses without a schema (${schemaGaps.length}):`);
  for (const gap of schemaGaps.sort()) console.log(`    - ${gap}`);
  console.log(
    `\n  Declare a response schema in apps/api/src/openapi/paths/, switch the ` +
      `response to 204, or add a justified entry to RESPONSE_SCHEMA_ALLOWLIST in this file.`,
  );
}

// ═══════════════════════════════════════════════════
// 7. Shared-Type ↔ OpenAPI Response Required-Field Comparison
// ═══════════════════════════════════════════════════
//
// Catches the "spec marks a response field optional that the shared-type marks
// required" class of drift: the SPA trusts the generated type and reads the
// field unconditionally, but the spec permits the server to omit it. For each
// registered (spec-schema ↔ shared-type) pair, assert that every type-required
// field is also required in the spec — restricted to fields the spec declares
// as properties, and skipping accepted exceptions in KNOWN_DRIFT.

console.log(`\n  7. Shared-Type <> OpenAPI Response Required-Field Comparison`);
console.log(`  ------------------------------------------------------------`);

interface ResponseDrift {
  description: string;
  issues: string[];
}

const responseDrifts: ResponseDrift[] = [];
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

  const known = new Set<string>(KNOWN_DRIFT[driftKey] ?? []);

  responseCompared++;
  const issues: string[] = [];
  compareShapeToSchema(shape, specSchema, "", known, issues);

  if (issues.length > 0) {
    responseDrifts.push({ description: entry.description, issues });
  }
}

console.log(`  Compared: ${responseCompared}/${responseTypeRegistry.length} registry entries\n`);

if (responseDrifts.length === 0) {
  console.log(`  OK — every registered response schema requires what its shared-type requires.`);
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
    `  Tighten the spec response schema's required array to match the shared-type, ` +
      `or record the divergence in KNOWN_DRIFT in ` +
      `apps/api/src/openapi/response-type-registry.ts with a justification.`,
  );
}

// Coverage enforcement — every named component schema must be either registered
// (a shared-type pair, checked above) or explicitly EXEMPT (no shared-type
// consumer). This makes step 7 fail-closed: a new response schema can't slip
// in unchecked. The opt-in gap (a schema nobody registers is never compared)
// is closed by requiring an explicit, justified decision for every schema.
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

// @ts-ignore Bun's type definitions for process.exit are incorrect (they say it returns never, but it actually returns void), so we ignore the type error here.
process.exit(exitCode);
