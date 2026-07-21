// SPDX-License-Identifier: Apache-2.0

/**
 * Test application builder.
 *
 * Creates a Hono app with the same middleware chain and routes as the production app,
 * but WITHOUT calling boot() (no Docker, no S3, no system packages, no scheduler).
 *
 * Mounts core routes plus every module discovered by the root test preload (see
 * test/setup/preload.ts and test-modules.ts). Discovery is filesystem-based — any
 * directory under apps/api/src/modules/<name>/ with an index.ts is picked up.
 *
 * Default behavior: the preload populates a shared registry before any test
 * file runs, and getTestApp() reads from it. Core tests and module tests thus
 * share a single cached app, which matters when `bun test` runs from the repo
 * root with its recursive file glob (one process, one app).
 *
 * Escape hatch: pass `{ modules: [...] }` to bypass discovery and get a fresh
 * app with an explicit module list. Use `{ modules: [] }` to assert the
 * zero-footprint invariant (no modules → no module routes, no module
 * app-scoped prefixes). The explicit path never touches the singleton cache.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { requestId } from "../../src/middleware/request-id.ts";
import { errorHandler } from "../../src/middleware/error-handler.ts";
import { apiVersion } from "../../src/middleware/api-version.ts";
import { requireAppContext } from "../../src/middleware/app-context.ts";
import { getOrgSettings } from "../../src/services/organizations.ts";
import { initSystemProxies } from "../../src/services/proxy-registry.ts";
import { initSystemModelProviderKeys } from "../../src/services/model-registry.ts";
import { initSystemIntegrations } from "../../src/services/integration-client-registry.ts";
import { initRunLimits } from "../../src/services/run-limits.ts";
import { initProxyLimits } from "../../src/services/proxy-limits.ts";
import { seedTestModelProviders } from "./model-providers.ts";
import { applyAuthPipeline, skipAuth } from "../../src/lib/auth-pipeline.ts";
import { createAuthBootstrapRouter } from "../../src/routes/auth-bootstrap.ts";
import { collectModulePermissions } from "../../src/lib/modules/module-loader.ts";
import { setModulePermissionsProvider } from "@appstrate/core/permissions";
import { initAppConfig } from "../../src/lib/app-config.ts";
import { notFound } from "../../src/lib/errors.ts";
import { buildOpenApiSpec } from "../../src/openapi/index.ts";
import { createResponseValidationMiddleware } from "./response-validation.ts";

// Route imports
import { createAgentsRouter } from "../../src/routes/agents.ts";
import { createRunsRouter } from "../../src/routes/runs.ts";
import { createRunsEventsRouter } from "../../src/routes/runs-events.ts";
import { createRunsRemoteRouter } from "../../src/routes/runs-remote.ts";
import { createSchedulesRouter } from "../../src/routes/schedules.ts";
import { createUserAgentsRouter } from "../../src/routes/user-agents.ts";
import { createApiKeysRouter } from "../../src/routes/api-keys.ts";
import { createProxiesRouter } from "../../src/routes/proxies.ts";
import { createModelsRouter } from "../../src/routes/models.ts";
import { createModelProvidersOAuthRouter } from "../../src/routes/model-providers-oauth.ts";
import { createModelProviderCredentialsRouter } from "../../src/routes/model-provider-credentials.ts";
import { createInternalRouter } from "../../src/routes/internal.ts";
import { createApplicationsRouter } from "../../src/routes/applications.ts";
import { createNotificationsRouter } from "../../src/routes/notifications.ts";
import { createPackagesRouter } from "../../src/routes/packages.ts";
import { createRealtimeRouter } from "../../src/routes/realtime.ts";
import { createEndUsersRouter } from "../../src/routes/end-users.ts";
import { createUploadsRouter, createUploadContentRouter } from "../../src/routes/uploads.ts";
import { createCredentialProxyRouter } from "../../src/routes/credential-proxy.ts";
import { createLlmProxyRouter } from "../../src/routes/llm-proxy.ts";
import { createDesktopRouter } from "../../src/routes/desktop.ts";
import { getDiscoveredModules } from "./test-modules.ts";
import healthRouter from "../../src/routes/health.ts";
import { createIntegrationsRouter } from "../../src/routes/integrations.ts";
import orgsRouter from "../../src/routes/organizations.ts";
import meRouter from "../../src/routes/me.ts";
import profileRouter from "../../src/routes/profile.ts";
import invitationsRouter from "../../src/routes/invitations.ts";
import welcomeRouter from "../../src/routes/welcome.ts";

import type { AppstrateModule } from "@appstrate/core/module";
import type { AppEnv } from "../../src/types/index.ts";

export interface GetTestAppOptions {
  /**
   * Explicit module list to mount. When provided, bypasses the preload-
   * populated discovery registry and returns a fresh (non-cached) app.
   *
   * Pass `[]` to assert the zero-footprint invariant: a core-only app with
   * no module routes, no module app-scoped prefixes, no module-contributed
   * middleware. Core tests that want to prove isolation should use this.
   */
  modules?: readonly AppstrateModule[];
}

let cachedApp: Hono<AppEnv> | null = null;

// Initialize boot-time singletons that core routes depend on.
initSystemProxies(); // initializes from SYSTEM_PROXIES env var (empty array in test)
initSystemIntegrations(); // SYSTEM_INTEGRATIONS — empty array in test; tests seed via initSystemIntegrations([...])
initRunLimits(); // PLATFORM_RUN_LIMITS / INLINE_RUN_LIMITS — defaults when unset
initProxyLimits(); // LLM_PROXY_LIMITS / CREDENTIAL_PROXY_LIMITS — defaults when unset
// Seed the runtime model-provider registry to the canonical test
// baseline. Tests bypass boot.ts so the usual module-contribution
// aggregation has to happen here. The helper lives in
// `./model-providers.ts` so unit tests that only need the reseed don't
// have to import the full Hono app builder. MUST run before
// initSystemModelProviderKeys() because env entries resolve their
// apiShape/baseUrl from the registry by providerId.
seedTestModelProviders();
initSystemModelProviderKeys(); // initializes from SYSTEM_PROVIDER_KEYS env var (empty array in test)
await initAppConfig(); // initializes app config (routes like organizations.ts call getAppConfig())

/**
 * Get the test Hono app (singleton — created once per test run).
 *
 * Mirrors the production middleware chain from index.ts:
 * CORS → error handler → request ID → Better Auth → API key auth → org context → routes
 *
 * Skips: boot(), static files, SPA fallback, shutdown gate, OpenAPI docs, cloud routes.
 */
export function getTestApp(options?: GetTestAppOptions): Hono<AppEnv> {
  // Explicit module list → always return a fresh app (never touches the
  // singleton cache, so core "modules: []" tests stay isolated from the
  // preload-discovered default app used by every other test).
  const explicit = options?.modules !== undefined;
  const extraModules = explicit ? options!.modules! : getDiscoveredModules();

  // Register module RBAC contributions BEFORE returning the app — mirrors
  // production wiring in `initSortedModules()`, which calls
  // `setModulePermissionsProvider` before init() runs so
  // `resolvePermissions(role)` already sees module grants when modules are
  // loaded. Without this, module-owned resources (e.g. `webhooks:*`,
  // `oauth-clients:*` after they were extracted out of the static core
  // catalog) are absent from the session's permission Set and every
  // guarded route 403s.
  //
  // This call sits OUTSIDE the cached-app check because
  // `module-loader.test.ts` legitimately resets the provider in its
  // `beforeEach`, and a subsequent integration test that reuses the
  // cached `cachedApp` would otherwise hit an empty module permission
  // snapshot. Computing the snapshot is cheap — single pass over the
  // contributions array — so re-registering per call is acceptable.
  const rbacSnapshot = collectModulePermissions(extraModules);
  setModulePermissionsProvider(() => rbacSnapshot);

  if (!explicit && cachedApp) return cachedApp;

  const app = new Hono<AppEnv>();

  // Error handler
  app.onError(errorHandler);

  // Request-Id
  app.use("*", requestId());

  // CORS
  app.use("*", cors({ origin: "*", credentials: true }));

  // Response-contract gate: validate every JSON response against its OpenAPI
  // schema, fail-closed. The spec is assembled from the SAME module set this
  // app mounts (core-only when `modules: []`), so module routes are checked
  // against their own contributed paths/schemas. Registered before any route
  // so it wraps them all. See ./response-validation.ts for scope + behavior.
  const moduleApiPaths = Object.assign({}, ...extraModules.map((m) => m.openApiPaths?.() ?? {}));
  const moduleApiSchemas = Object.assign(
    {},
    ...extraModules.map((m) => m.openApiComponentSchemas?.() ?? {}),
  );
  const moduleApiTags = extraModules.flatMap((m) => m.openApiTags?.() ?? []);
  // On by default (CI enforces it). `DISABLE_RESPONSE_CONTRACT=1` is an
  // escape hatch for debugging an unrelated failing test in isolation.
  if (process.env.DISABLE_RESPONSE_CONTRACT !== "1") {
    app.use(
      "*",
      createResponseValidationMiddleware(
        buildOpenApiSpec(moduleApiPaths, moduleApiSchemas, moduleApiTags),
      ),
    );
  }

  // Health check (no auth)
  app.route("/", healthRouter);

  // Module-contributed public paths (e.g. inbound webhooks, OIDC login page).
  // The test harness collects from `extraModules` directly — it does not go
  // through the production module loader registry, so we build the set once
  // here and reuse it for the auth pipeline and the downstream middlewares.
  const modulePublicPaths = new Set(extraModules.flatMap((m) => m.publicPaths ?? []));

  // Bootstrap-token redemption (#344 Layer 2b) — registered BEFORE the
  // Better Auth catch-all so the more-specific path wins. Mirrors the
  // production wiring in `apps/api/src/index.ts`.
  app.route("/api/auth/bootstrap", createAuthBootstrapRouter());

  // Shared auth pipeline — mirrors production exactly. Accessors return the
  // same snapshotted values every call (the test module list does not change
  // across a run).
  const moduleAuthStrategies = extraModules.flatMap((m) => m.authStrategies?.() ?? []);
  applyAuthPipeline(app, {
    publicPaths: () => modulePublicPaths,
    authStrategies: () => moduleAuthStrategies,
  });

  // App context middleware: resolve X-Application-Id for app-scoped routes.
  // Core-only prefix list — modules own app-scoping for their own routes.
  const APP_SCOPED_PREFIXES = [
    "/api/agents",
    "/api/runs",
    "/api/schedules",
    "/api/end-users",
    "/api/api-keys",
    "/api/notifications",
    "/api/packages",
    "/api/integrations",
    "/api/uploads",
  ];

  const appContextMiddleware = requireAppContext();
  app.use("*", async (c, next) => {
    if (skipAuth(c.req.path, modulePublicPaths)) return next();
    if (!c.get("user")) return next();
    if (!APP_SCOPED_PREFIXES.some((p) => c.req.path.startsWith(p))) return next();
    return appContextMiddleware(c, next);
  });

  // API versioning — mirrors production: read settings stashed on context
  // by `requireOrgContext` (session auth), fall back to a direct lookup for
  // auth paths that resolve orgId inline (API key, module strategies).
  const apiVersionMiddleware = apiVersion(async (orgId, c) => {
    const settings = c.get("orgSettings") ?? (await getOrgSettings(orgId));
    return settings.api_version ?? null;
  });
  app.use("*", async (c, next) => {
    if (skipAuth(c.req.path, modulePublicPaths)) return next();
    if (!c.get("user")) return next();
    return apiVersionMiddleware(c, next);
  });

  // Mount routes (same order as production)
  const userAgentsRouter = createUserAgentsRouter();
  const agentsRouter = createAgentsRouter();
  const runsRouter = createRunsRouter();
  const schedulesRouter = createSchedulesRouter();

  app.route("/api/orgs", orgsRouter);
  app.route("/api/me", meRouter);
  app.route("/api/agents", userAgentsRouter);
  app.route("/api/agents", agentsRouter);
  app.route("/api", createNotificationsRouter());
  // HMAC-signed event ingestion. Must mount BEFORE runsRouter so the
  // more-specific `/runs/:runId/events` path wins — mirrors the
  // production wiring in `apps/api/src/index.ts`.
  app.route("/api", createRunsEventsRouter());
  // Runner-facing remote-run creation (`POST /api/runs/remote` + sink
  // extension). Mounts under `/api` because the router declares its own
  // `/runs/...` prefixes — same shape as production.
  app.route("/api", createRunsRemoteRouter());
  app.route("/api", runsRouter);
  app.route("/api", schedulesRouter);
  app.route("/api/packages", createPackagesRouter());
  app.route("/api/end-users", createEndUsersRouter());
  // FS direct-upload sink MUST register BEFORE /api/uploads — more specific
  // path first. Mirrors production wiring in `apps/api/src/index.ts`.
  app.route("/api/uploads/_content", createUploadContentRouter());
  app.route("/api/uploads", createUploadsRouter());
  for (const mod of extraModules) {
    const moduleRouter = mod.createRouter?.();
    // Modules mount at the HTTP origin root — they declare full paths
    // (`/api/*` for business endpoints, `/.well-known/*` for RFC-specified
    // well-known URIs). Matches production wiring in
    // `apps/api/src/index.ts` → `registerModuleRoutes`.
    if (moduleRouter) app.route("/", moduleRouter);
  }
  app.route("/api/api-keys", createApiKeysRouter());
  app.route("/api/proxies", createProxiesRouter());
  app.route("/api/models", createModelsRouter());
  app.route("/api/model-provider-credentials", createModelProviderCredentialsRouter());
  app.route("/api/model-providers-oauth", createModelProvidersOAuthRouter());
  app.route("/api/applications", createApplicationsRouter());
  app.route("/api", profileRouter);
  app.route("/api/realtime", createRealtimeRouter());
  app.route("/api/integrations", createIntegrationsRouter());
  app.route("/api/credential-proxy", createCredentialProxyRouter());
  app.route("/api/llm-proxy", createLlmProxyRouter());
  app.route("/api/desktop", createDesktopRouter());
  app.route("/invite", invitationsRouter);
  app.route("/api", welcomeRouter);
  app.route("/internal", createInternalRouter());

  // Mirrors production: unknown /api/* → 404 problem+json (no SPA fallback in tests).
  app.all("/api/*", (c) => {
    const pathname = new URL(c.req.url).pathname;
    throw notFound(`API endpoint not found: ${c.req.method} ${pathname}`);
  });

  if (!explicit) cachedApp = app;
  return app;
}
