// SPDX-License-Identifier: Apache-2.0

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

  // Packages — Agents
  "POST /api/packages/agents",
  "GET /api/packages/agents/{scope}/{name}",
  "PUT /api/packages/agents/{scope}/{name}",
  "DELETE /api/packages/agents/{scope}/{name}",
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
