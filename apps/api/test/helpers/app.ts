/**
 * Test application builder.
 *
 * Creates a Hono app with the same middleware chain and routes as the production app,
 * but WITHOUT calling boot() (no Docker, no S3, no system packages, no scheduler).
 *
 * This allows integration tests to exercise the full HTTP → middleware → auth → service → DB
 * pipeline with a real database.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { auth } from "../../src/lib/auth.ts";
import { validateApiKey } from "../../src/services/api-keys.ts";
import { ensureDefaultProfile } from "../../src/services/connection-profiles.ts";
import { requireOrgContext } from "../../src/middleware/org-context.ts";
import { requestId } from "../../src/middleware/request-id.ts";
import { errorHandler } from "../../src/middleware/error-handler.ts";
import { isEndUserInApp } from "../../src/services/end-users.ts";
import { ApiError, unauthorized } from "../../src/lib/errors.ts";
import { logger } from "../../src/lib/logger.ts";
import { loadCloud } from "../../src/lib/cloud-loader.ts";
import { initSystemProxies } from "../../src/services/proxy-registry.ts";
import { initSystemProviderKeys } from "../../src/services/model-registry.ts";

// Route imports
import { createFlowsRouter } from "../../src/routes/flows.ts";
import { createExecutionsRouter } from "../../src/routes/executions.ts";
import { createSchedulesRouter } from "../../src/routes/schedules.ts";
import { createUserFlowsRouter } from "../../src/routes/user-flows.ts";
import { createShareRouter } from "../../src/routes/share.ts";
import { createProvidersRouter } from "../../src/routes/providers.ts";
import { createApiKeysRouter } from "../../src/routes/api-keys.ts";
import { createProxiesRouter } from "../../src/routes/proxies.ts";
import { createModelsRouter } from "../../src/routes/models.ts";
import { createProviderKeysRouter } from "../../src/routes/provider-keys.ts";
import { createInternalRouter } from "../../src/routes/internal.ts";
import { createApplicationsRouter } from "../../src/routes/applications.ts";
import { createConnectionProfilesRouter } from "../../src/routes/connection-profiles.ts";
import { createNotificationsRouter } from "../../src/routes/notifications.ts";
import { createPackagesRouter } from "../../src/routes/packages.ts";
import { createRealtimeRouter } from "../../src/routes/realtime.ts";
import { createEndUsersRouter } from "../../src/routes/end-users.ts";
import { createWebhooksRouter } from "../../src/routes/webhooks.ts";
import healthRouter from "../../src/routes/health.ts";
import authRouter from "../../src/routes/auth.ts";
import orgsRouter from "../../src/routes/organizations.ts";
import profileRouter from "../../src/routes/profile.ts";
import invitationsRouter from "../../src/routes/invitations.ts";
import welcomeRouter from "../../src/routes/welcome.ts";

import type { AppEnv } from "../../src/types/index.ts";

let cachedApp: Hono<AppEnv> | null = null;

// Initialize boot-time singletons that routes depend on.
// In production these are called by boot(). For tests, we call them directly.
await loadCloud().catch(() => {}); // sets _cloud to null (OSS mode)
initSystemProxies(); // initializes from SYSTEM_PROXIES env var (empty array in test)
initSystemProviderKeys(); // initializes from SYSTEM_PROVIDER_KEYS env var (empty array in test)

/**
 * Get the test Hono app (singleton — created once per test run).
 *
 * Mirrors the production middleware chain from index.ts:
 * CORS → error handler → request ID → Better Auth → API key auth → org context → routes
 *
 * Skips: boot(), static files, SPA fallback, shutdown gate, OpenAPI docs, cloud routes.
 */
export function getTestApp(): Hono<AppEnv> {
  if (cachedApp) return cachedApp;

  const app = new Hono<AppEnv>();

  // Error handler
  app.onError(errorHandler);

  // Request-Id
  app.use("*", requestId());

  // CORS
  app.use("*", cors({ origin: "*", credentials: true }));

  // Health check (no auth)
  app.route("/", healthRouter);

  // Auth paths that skip auth middleware
  function skipAuth(path: string): boolean {
    if (!path.startsWith("/api/") && !path.startsWith("/auth/")) return true;
    if (path.startsWith("/api/auth/")) return true;
    if (path.startsWith("/api/realtime/")) return true;
    if (path === "/auth/callback") return true;
    if (path === "/api/docs" || path === "/api/openapi.json") return true;
    return false;
  }

  function skipOrgContext(path: string): boolean {
    if (path === "/api/orgs" || path === "/api/orgs/") return true;
    if (path.startsWith("/api/orgs/")) return true;
    if (path === "/api/profile" || path === "/api/profile/") return true;
    if (path === "/api/profiles/batch") return true;
    if (path === "/api/welcome/setup") return true;
    return false;
  }

  // Better Auth handler
  app.on(["POST", "GET"], "/api/auth/*", (c) => {
    return auth.handler(c.req.raw);
  });

  // Auth middleware (same as production)
  app.use("*", async (c, next) => {
    if (skipAuth(c.req.path)) return next();

    // Try Bearer API key first
    const authHeader = c.req.header("Authorization");
    if (authHeader?.startsWith("Bearer ask_")) {
      const rawKey = authHeader.slice(7);
      const keyInfo = await validateApiKey(rawKey);
      if (!keyInfo) {
        throw unauthorized("Invalid or expired API key");
      }
      c.set("user", { id: keyInfo.userId, email: keyInfo.email, name: keyInfo.name });
      c.set("orgId", keyInfo.orgId);
      c.set("orgSlug", keyInfo.orgSlug);
      c.set("orgRole", "admin");
      c.set("authMethod", "api_key");
      c.set("apiKeyId", keyInfo.keyId);
      c.set("applicationId", keyInfo.applicationId);

      // Appstrate-User header
      const targetEndUserId = c.req.header("Appstrate-User");
      if (targetEndUserId) {
        if (!targetEndUserId.startsWith("eu_")) {
          throw new ApiError({
            status: 400,
            code: "invalid_end_user_id",
            title: "Invalid End-User ID",
            detail: `Appstrate-User header must be an end-user ID with 'eu_' prefix, got '${targetEndUserId}'`,
            param: "Appstrate-User",
          });
        }
        const endUser = await isEndUserInApp(keyInfo.applicationId, targetEndUserId);
        if (!endUser) {
          throw new ApiError({
            status: 403,
            code: "invalid_end_user",
            title: "Invalid End-User",
            detail: `End-user '${targetEndUserId}' does not exist or does not belong to this application`,
            param: "Appstrate-User",
          });
        }
        c.set("endUser", endUser);
      }

      return next();
    }

    // Fallback: cookie session
    const sessionResult = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!sessionResult?.user) {
      throw unauthorized("Invalid or missing session");
    }

    // Appstrate-User header NOT allowed with cookie auth
    if (c.req.header("Appstrate-User")) {
      throw new ApiError({
        status: 400,
        code: "header_not_allowed",
        title: "Header Not Allowed",
        detail: "Appstrate-User header is not allowed with cookie authentication",
        param: "Appstrate-User",
      });
    }

    c.set("user", {
      id: sessionResult.user.id,
      email: sessionResult.user.email ?? "",
      name: sessionResult.user.name ?? "",
    });
    c.set("authMethod", "session");

    // Ensure default profile (fire-and-forget, same as production)
    ensureDefaultProfile({ type: "member", id: sessionResult.user.id }).catch(() => {});

    return next();
  });

  // Org context middleware
  app.use("*", async (c, next) => {
    const path = c.req.path;
    if (skipAuth(path)) return next();
    if (!c.get("user")) return next();
    if (c.get("authMethod") === "api_key") return next();
    if (skipOrgContext(path)) return next();
    return requireOrgContext()(c, next);
  });

  // Mount routes (same order as production)
  const userFlowsRouter = createUserFlowsRouter();
  const flowsRouter = createFlowsRouter();
  const executionsRouter = createExecutionsRouter();
  const schedulesRouter = createSchedulesRouter();

  app.route("/api/orgs", orgsRouter);
  app.route("/api/flows", userFlowsRouter);
  app.route("/api/flows", flowsRouter);
  app.route("/api", createNotificationsRouter());
  app.route("/api", executionsRouter);
  app.route("/api", schedulesRouter);
  app.route("/api/packages", createPackagesRouter());
  app.route("/api/end-users", createEndUsersRouter());
  app.route("/api/webhooks", createWebhooksRouter());
  app.route("/api/providers", createProvidersRouter());
  app.route("/api/api-keys", createApiKeysRouter());
  app.route("/api/proxies", createProxiesRouter());
  app.route("/api/models", createModelsRouter());
  app.route("/api/provider-keys", createProviderKeysRouter());
  app.route("/api/applications", createApplicationsRouter());
  app.route("/api/connection-profiles", createConnectionProfilesRouter());
  app.route("/api", profileRouter);
  app.route("/api/realtime", createRealtimeRouter());
  app.route("/auth", authRouter);
  app.route("/invite", invitationsRouter);
  app.route("/share", createShareRouter());
  app.route("/api", welcomeRouter);
  app.route("/internal", createInternalRouter());

  cachedApp = app;
  return app;
}
