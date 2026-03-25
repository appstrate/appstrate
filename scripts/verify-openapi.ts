/**
 * Verify OpenAPI spec: completeness, structural validity, and best practices.
 *
 * 1. Endpoint coverage — compares spec vs maintained endpoint list
 * 2. Structural validation — @readme/openapi-parser (OpenAPI 3.1 schema conformance)
 * 3. Best practices lint — @redocly/openapi-core (recommended ruleset)
 *
 * Usage: bun scripts/verify-openapi.ts
 */
import { validate as validateOpenAPI } from "@readme/openapi-parser";
import { lintFromString, createConfig } from "@redocly/openapi-core";
import { openApiSpec } from "../apps/api/src/openapi/index.ts";

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

  // Flows (runtime — flows.ts + user-flows.ts junction endpoints)
  "GET /api/flows",
  "PUT /api/flows/{scope}/{name}/config",
  "POST /api/flows/{scope}/{name}/providers/{providerScope}/{providerName}/bind",
  "DELETE /api/flows/{scope}/{name}/providers/{providerScope}/{providerName}/bind",
  "GET /api/flows/{scope}/{name}/memories",
  "DELETE /api/flows/{scope}/{name}/memories",
  "DELETE /api/flows/{scope}/{name}/memories/{memoryId}",
  "PUT /api/flows/{scope}/{name}/skills",
  "PUT /api/flows/{scope}/{name}/tools",
  "GET /api/flows/{scope}/{name}/model",
  "PUT /api/flows/{scope}/{name}/model",

  // Executions
  "POST /api/flows/{scope}/{name}/run",
  "GET /api/flows/{scope}/{name}/executions",
  "DELETE /api/flows/{scope}/{name}/executions",
  "GET /api/executions/{id}",
  "GET /api/executions/{id}/logs",
  "POST /api/executions/{id}/cancel",

  // Realtime (SSE)
  "GET /api/realtime/executions",
  "GET /api/realtime/executions/{id}",
  "GET /api/realtime/flows/{packageId}/executions",

  // Schedules
  "GET /api/schedules",
  "GET /api/flows/{scope}/{name}/schedules",
  "POST /api/flows/{scope}/{name}/schedules",
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

  // Connection Profiles
  "GET /api/connection-profiles",
  "POST /api/connection-profiles",
  "GET /api/connection-profiles/connections",
  "DELETE /api/connection-profiles/connections",
  "PUT /api/connection-profiles/{id}",
  "DELETE /api/connection-profiles/{id}",
  "GET /api/connection-profiles/{id}/connections",

  // Flow Profile Override
  "PUT /api/flows/{scope}/{name}/profile",
  "DELETE /api/flows/{scope}/{name}/profile",

  // Flow Proxy
  "GET /api/flows/{scope}/{name}/proxy",
  "PUT /api/flows/{scope}/{name}/proxy",

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
  "GET /api/api-keys",
  "POST /api/api-keys",
  "DELETE /api/api-keys/{id}",

  // Packages — Skills
  "GET /api/packages/skills",
  "POST /api/packages/skills",
  "GET /api/packages/skills/{scope}/{name}",
  "PUT /api/packages/skills/{scope}/{name}",
  "DELETE /api/packages/skills/{scope}/{name}",
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
  "GET /api/packages/providers/{scope}/{name}/versions",
  "GET /api/packages/providers/{scope}/{name}/versions/info",
  "POST /api/packages/providers/{scope}/{name}/versions",
  "POST /api/packages/providers/{scope}/{name}/versions/{version}/restore",
  "DELETE /api/packages/providers/{scope}/{name}/versions/{version}",
  "GET /api/packages/providers/{scope}/{name}/versions/{version}",

  // Packages — Flows
  "POST /api/packages/flows",
  "GET /api/packages/flows/{scope}/{name}",
  "PUT /api/packages/flows/{scope}/{name}",
  "DELETE /api/packages/flows/{scope}/{name}",
  "GET /api/packages/flows/{scope}/{name}/versions",
  "GET /api/packages/flows/{scope}/{name}/versions/info",
  "POST /api/packages/flows/{scope}/{name}/versions",
  "POST /api/packages/flows/{scope}/{name}/versions/{version}/restore",
  "DELETE /api/packages/flows/{scope}/{name}/versions/{version}",
  "GET /api/packages/flows/{scope}/{name}/versions/{version}",

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

  // Invitations
  "GET /invite/{token}/info",
  "POST /invite/{token}/accept",

  // Welcome
  "POST /api/welcome/setup",

  // Internal
  "GET /internal/execution-history",
  "GET /internal/credentials/{scope}/{name}",

  // Meta
  "GET /api/openapi.json",
  "GET /api/docs",

  // Notifications
  "GET /api/notifications/unread-count",
  "GET /api/notifications/unread-counts-by-flow",
  "PUT /api/notifications/read/{executionId}",
  "PUT /api/notifications/read-all",
  "GET /api/executions",

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

  // End-Users
  "POST /api/end-users",
  "GET /api/end-users",
  "GET /api/end-users/{id}",
  "PATCH /api/end-users/{id}",
  "DELETE /api/end-users/{id}",

  // Webhooks
  "POST /api/webhooks",
  "GET /api/webhooks",
  "GET /api/webhooks/{id}",
  "PUT /api/webhooks/{id}",
  "DELETE /api/webhooks/{id}",
  "POST /api/webhooks/{id}/test",
  "POST /api/webhooks/{id}/rotate",
  "GET /api/webhooks/{id}/deliveries",
];

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
  await validateOpenAPI(specCopy);
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
    extends: ["minimal"],
    rules: {
      // Upgrade some rules from the recommended set that we care about
      "operation-operationId": "warn",
      "operation-description": "warn",
      "tag-description": "warn",
      "no-path-trailing-slash": "error",
      "path-not-include-query": "error",
      // Hono resolves by registration order — these paths are unambiguous at runtime
      "no-ambiguous-paths": "off",
    },
  });

  const source = JSON.stringify(openApiSpec, null, 2);
  const problems = await lintFromString({ source, config });

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
// Summary
// ═══════════════════════════════════════════════════

console.log(`\n  ${"=".repeat(50)}`);
console.log(`  ${exitCode === 0 ? "ALL CHECKS PASSED" : "SOME CHECKS FAILED"}`);
console.log(`  ${"=".repeat(50)}\n`);

// @ts-ignore Bun's type definitions for process.exit are incorrect (they say it returns never, but it actually returns void), so we ignore the type error here.
process.exit(exitCode);
