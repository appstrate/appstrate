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
  "GET /api/flows/{packageId}",
  "PUT /api/flows/{packageId}/config",
  "POST /api/flows/{packageId}/services/{serviceId}/bind",
  "DELETE /api/flows/{packageId}/services/{serviceId}/bind",
  "POST /api/flows/{packageId}/share-token",
  "GET /api/flows/{packageId}/memories",
  "DELETE /api/flows/{packageId}/memories",
  "DELETE /api/flows/{packageId}/memories/{memoryId}",
  "PUT /api/flows/{packageId}/skills",
  "PUT /api/flows/{packageId}/extensions",

  // Executions
  "POST /api/flows/{packageId}/run",
  "GET /api/flows/{packageId}/executions",
  "DELETE /api/flows/{packageId}/executions",
  "GET /api/executions/{executionId}",
  "GET /api/executions/{executionId}/logs",
  "POST /api/executions/{executionId}/cancel",

  // Realtime (SSE)
  "GET /api/realtime/executions",
  "GET /api/realtime/executions/{executionId}",
  "GET /api/realtime/flows/{packageId}/executions",

  // Schedules
  "GET /api/schedules",
  "GET /api/flows/{packageId}/schedules",
  "POST /api/flows/{packageId}/schedules",
  "PUT /api/schedules/{scheduleId}",
  "DELETE /api/schedules/{scheduleId}",

  // Connections
  "GET /auth/connections",
  "GET /auth/integrations",
  "POST /auth/connect/{provider}",
  "POST /auth/connect/{provider}/api-key",
  "POST /auth/connect/{provider}/credentials",
  "GET /auth/callback",
  "DELETE /auth/connections/{provider}",

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
  "PUT /api/connection-profiles/{profileId}",
  "DELETE /api/connection-profiles/{profileId}",
  "GET /api/connection-profiles/{profileId}/connections",

  // Flow Profile Override
  "PUT /api/flows/{packageId}/profile",
  "DELETE /api/flows/{packageId}/profile",

  // Flow Proxy
  "GET /api/flows/{packageId}/proxy",
  "PUT /api/flows/{packageId}/proxy",

  // Proxies
  "GET /api/proxies",
  "POST /api/proxies",
  "PUT /api/proxies/default",
  "PUT /api/proxies/{proxyId}",
  "DELETE /api/proxies/{proxyId}",

  // API Keys
  "GET /api/api-keys",
  "POST /api/api-keys",
  "DELETE /api/api-keys/{keyId}",

  // Packages — Skills
  "GET /api/packages/skills",
  "POST /api/packages/skills",
  "GET /api/packages/skills/{skillId}",
  "PUT /api/packages/skills/{skillId}",
  "DELETE /api/packages/skills/{skillId}",
  "GET /api/packages/skills/{skillId}/versions",
  "GET /api/packages/skills/{skillId}/versions/info",
  "POST /api/packages/skills/{skillId}/versions",
  "POST /api/packages/skills/{skillId}/versions/{version}/restore",
  "DELETE /api/packages/skills/{skillId}/versions/{version}",
  "GET /api/packages/skills/{skillId}/versions/{version}",

  // Packages — Extensions
  "GET /api/packages/extensions",
  "POST /api/packages/extensions",
  "GET /api/packages/extensions/{extensionId}",
  "PUT /api/packages/extensions/{extensionId}",
  "DELETE /api/packages/extensions/{extensionId}",
  "GET /api/packages/extensions/{extensionId}/versions",
  "GET /api/packages/extensions/{extensionId}/versions/info",
  "POST /api/packages/extensions/{extensionId}/versions",
  "POST /api/packages/extensions/{extensionId}/versions/{version}/restore",
  "DELETE /api/packages/extensions/{extensionId}/versions/{version}",
  "GET /api/packages/extensions/{extensionId}/versions/{version}",

  // Packages — Flows
  "POST /api/packages/flows",
  "GET /api/packages/flows/{flowId}",
  "PUT /api/packages/flows/{flowId}",
  "DELETE /api/packages/flows/{flowId}",
  "GET /api/packages/flows/{flowId}/versions",
  "GET /api/packages/flows/{flowId}/versions/info",
  "POST /api/packages/flows/{flowId}/versions",
  "POST /api/packages/flows/{flowId}/versions/{version}/restore",
  "DELETE /api/packages/flows/{flowId}/versions/{version}",
  "GET /api/packages/flows/{flowId}/versions/{version}",

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

  // Share
  "GET /share/{token}/flow",
  "POST /share/{token}/run",
  "GET /share/{token}/status",

  // Welcome
  "POST /api/welcome/setup",

  // Internal
  "GET /internal/execution-history",
  "GET /internal/credentials/{serviceId}",

  // Meta
  "GET /api/openapi.json",
  "GET /api/docs",

  // Notifications
  "GET /api/notifications/unread-count",
  "PUT /api/notifications/read/{executionId}",
  "PUT /api/notifications/read-all",
  "GET /api/executions",

  // Marketplace
  "GET /api/marketplace/status",
  "GET /api/marketplace/search",
  "GET /api/marketplace/installed",
  "GET /api/marketplace/updates",
  "POST /api/marketplace/update",
  "GET /api/marketplace/packages/{scope}/{name}",
  "POST /api/marketplace/install",

  // Packages
  "POST /api/packages/import",
  "GET /api/packages/{packageId}/{version}/download",
  "GET /api/packages/{scope}/{name}/publish-plan",
  "POST /api/packages/{scope}/{name}/publish",
  "POST /api/packages/{scope}/{name}/fork",

  // Registry
  "POST /api/registry/connect",
  "GET /api/registry/callback",
  "DELETE /api/registry/disconnect",
  "GET /api/registry/status",
  "GET /api/registry/scopes",
  "POST /api/registry/scopes",
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
