import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { getEnv } from "@appstrate/env";
import { auth } from "./lib/auth.ts";
import { logger } from "./lib/logger.ts";
import { boot } from "./lib/boot.ts";
import { createShutdownHandler } from "./lib/shutdown.ts";
import { validateApiKey } from "./services/api-keys.ts";
import { ensureDefaultProfile } from "./services/connection-profiles.ts";
import { requireOrgContext } from "./middleware/org-context.ts";
import { requestId } from "./middleware/request-id.ts";
import { errorHandler } from "./middleware/error-handler.ts";
import { createFlowsRouter } from "./routes/flows.ts";
import { createExecutionsRouter } from "./routes/executions.ts";
import { createSchedulesRouter } from "./routes/schedules.ts";
import { createUserFlowsRouter } from "./routes/user-flows.ts";
import { createProvidersRouter } from "./routes/providers.ts";
import { createApiKeysRouter } from "./routes/api-keys.ts";
import { createProxiesRouter } from "./routes/proxies.ts";
import { createModelsRouter } from "./routes/models.ts";
import { createProviderKeysRouter } from "./routes/provider-keys.ts";
import { createInternalRouter } from "./routes/internal.ts";
import { createApplicationsRouter } from "./routes/applications.ts";
import { createConnectionProfilesRouter } from "./routes/connection-profiles.ts";
import { createNotificationsRouter } from "./routes/notifications.ts";
import { createPackagesRouter } from "./routes/packages.ts";
import { createRealtimeRouter } from "./routes/realtime.ts";
import { createEndUsersRouter } from "./routes/end-users.ts";
import { createWebhooksRouter } from "./routes/webhooks.ts";
import healthRouter from "./routes/health.ts";
import connectionsRouter from "./routes/connections.ts";
import orgsRouter from "./routes/organizations.ts";
import profileRouter from "./routes/profile.ts";
import invitationsRouter from "./routes/invitations.ts";
import welcomeRouter from "./routes/welcome.ts";
import { swaggerUI } from "@hono/swagger-ui";
import { openApiSpec } from "./openapi/index.ts";
import { getCloudModule } from "./lib/cloud-loader.ts";
import { ApiError, unauthorized } from "./lib/errors.ts";
import { isEndUserInApp } from "./services/end-users.ts";
import { apiVersion } from "./middleware/api-version.ts";
import { getOrgSettings } from "./services/organizations.ts";
import type { AppEnv } from "./types/index.ts";
import type { AppConfig } from "@appstrate/shared-types";

// Fail-fast: validate all env vars at startup
const env = getEnv();

const app = new Hono<AppEnv>();

// Error handler — converts ApiError to RFC 9457 application/problem+json
app.onError(errorHandler);

// Request-Id — generates req_ prefixed ID, sets header + context variable
app.use("*", requestId());

// Middleware
const trustedOrigins = env.TRUSTED_ORIGINS;

app.use("*", cors({ origin: trustedOrigins, credentials: true }));

// Health check — before auth middleware (no auth required)
app.route("/", healthRouter);

// OpenAPI docs — public (before auth middleware)
app.get("/api/openapi.json", (c) => c.json(openApiSpec));
app.get("/api/docs", swaggerUI({ url: "/api/openapi.json" }));

// Platform config — computed once at boot, injected into SPA HTML.
// In OSS (no cloud module): models & provider keys visible, billing hidden.
// In Cloud (@appstrate/cloud loaded): models & provider keys hidden (platform-managed), billing visible.
function buildAppConfig(): AppConfig {
  const isCloud = getCloudModule() !== null;
  return {
    platform: isCloud ? "cloud" : "oss",
    features: {
      billing: isCloud,
      models: !isCloud,
      providerKeys: !isCloud,
      googleAuth: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
      emailVerification: !!(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS && env.SMTP_FROM),
    },
    trustedOrigins: env.TRUSTED_ORIGINS,
  };
}

// Shutdown gate — reject new write requests during graceful shutdown
let shuttingDown = false;

app.use("*", async (c, next) => {
  if (shuttingDown && c.req.method === "POST") {
    throw new ApiError({
      status: 503,
      code: "shutting_down",
      title: "Service Unavailable",
      detail: "Server is shutting down",
    });
  }
  return next();
});

// Mount Better Auth handler — handles signup, signin, session, etc.
app.on(["POST", "GET"], "/api/auth/*", (c) => {
  return auth.handler(c.req.raw);
});

// Paths that skip both auth and org-context middleware (handled by other means or public)
function skipAuth(path: string): boolean {
  if (!path.startsWith("/api/")) return true;
  if (path.startsWith("/api/auth/")) return true; // Better Auth handles its own auth
  if (path.startsWith("/api/realtime/")) return true; // SSE endpoints use cookie auth internally
  if (path === "/api/connections/callback") return true; // OAuth redirect — no session
  if (path === "/api/docs" || path === "/api/openapi.json") return true;
  if (getCloudModule()?.publicPaths.includes(path)) return true; // e.g. Stripe webhook
  return false;
}

// Paths that need auth but not org-context (user-scoped or self-resolving)
function skipOrgContext(path: string): boolean {
  if (path === "/api/orgs" || path === "/api/orgs/") return true; // list/create orgs
  if (path.startsWith("/api/orgs/")) return true; // /api/orgs/:id/* handle their own auth
  if (path === "/api/profile" || path === "/api/profile/") return true;
  if (path === "/api/profiles/batch") return true;
  if (path === "/api/welcome/setup") return true;
  return false;
}

// Auth middleware: verify Bearer API key OR Better Auth session (cookie-based)
app.use("*", async (c, next) => {
  if (skipAuth(c.req.path)) return next();

  // Try Bearer API key first
  const authHeader = c.req.header("Authorization");
  if (authHeader?.startsWith("Bearer ask_")) {
    const rawKey = authHeader.slice(7); // "Bearer ".length
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

    // Appstrate-User header: resolve end-user context (API key only)
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
      logger.info("Appstrate-User end-user context", {
        requestId: c.get("requestId"),
        apiKeyId: keyInfo.keyId,
        authenticatedMember: keyInfo.userId,
        endUserId: endUser.id,
        applicationId: endUser.applicationId,
        method: c.req.method,
        path: c.req.path,
        ip:
          c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
          c.req.header("x-real-ip") ||
          "unknown",
        userAgent: c.req.header("user-agent") || "unknown",
      });
      c.set("endUser", endUser);
    }

    return next();
  }

  // Fallback: cookie session
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session?.user) {
    throw unauthorized("Invalid or missing session");
  }

  // Appstrate-User header is NOT allowed with cookie auth
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
    id: session.user.id,
    email: session.user.email ?? "",
    name: session.user.name ?? "",
  });
  c.set("authMethod", "session");

  // Ensure the user has a default connection profile
  ensureDefaultProfile({ type: "member", id: session.user.id }).catch((err) => {
    logger.warn("Failed to ensure default profile", {
      userId: session.user.id,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  return next();
});

// Org context middleware: require X-Org-Id for org-scoped /api/* routes
app.use("*", async (c, next) => {
  const path = c.req.path;
  if (skipAuth(path)) return next(); // public paths also skip org context
  if (!c.get("user")) return next(); // no auth resolved — nothing to do
  if (c.get("authMethod") === "api_key") return next(); // API key already resolved orgId
  if (skipOrgContext(path)) return next();

  return requireOrgContext()(c, next);
});

// API versioning: resolve Appstrate-Version header > org setting > default
const apiVersionMiddleware = apiVersion({
  getOrgApiVersion: async (orgId) => {
    const settings = await getOrgSettings(orgId);
    return settings.apiVersion ?? null;
  },
});
app.use("*", async (c, next) => {
  if (skipAuth(c.req.path)) return next();
  if (!c.get("user")) return next();
  return apiVersionMiddleware(c, next);
});

// Boot: load system resources, init services, clean up orphans
await boot();

// Pre-compute config script (config is static after boot — cloud module is loaded or not)
const appConfigScript = `<script>window.__APP_CONFIG__=${JSON.stringify(buildAppConfig())};</script>`;

// Graceful shutdown
const shutdown = createShutdownHandler(() => {
  shuttingDown = true;
});
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

// Routes
const userFlowsRouter = createUserFlowsRouter();
const flowsRouter = createFlowsRouter();
const executionsRouter = createExecutionsRouter();
const schedulesRouter = createSchedulesRouter();

// Organization routes (no org context needed — self-managed auth)
app.route("/api/orgs", orgsRouter);

app.route("/api/flows", userFlowsRouter); // Must be before flowsRouter (import/delete routes)
app.route("/api/flows", flowsRouter);
app.route("/api", createNotificationsRouter()); // Must be before executionsRouter (GET /api/executions vs /api/executions/:id)
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
app.route("/api/connections", connectionsRouter);

// Public invitation routes (no auth required — path doesn't start with /api/ or /auth/)
app.route("/invite", invitationsRouter);

// Welcome route (authenticated, cookie-based — org context not required)
app.route("/api", welcomeRouter);

// Internal routes (container-to-host, auth via execution token — no JWT)
const internalRouter = createInternalRouter();
app.route("/internal", internalRouter);

// Cloud routes (billing, webhooks — no-op in OSS)
const cloud = getCloudModule();
if (cloud) {
  cloud.registerCloudRoutes(app);
}

// Static files for UI (JS, CSS, images, fonts — skip index.html, served with config below)
app.use(
  "/*",
  serveStatic({
    root: "./apps/web/dist",
    rewriteRequestPath: (path) => (path === "/" || path === "/index.html" ? "/.noop" : path),
  }),
);

// SPA fallback — serve index.html with injected app config for all non-asset routes.
// Read fresh each time: Vite build --watch rewrites index.html with new asset hashes.
app.get("/*", async (c) => {
  const raw = await Bun.file("./apps/web/dist/index.html").text();
  return c.html(raw.replace("</head>", `${appConfigScript}\n</head>`));
});

// Start server
export default {
  port: env.PORT,
  fetch: app.fetch,
  idleTimeout: 255,
};

logger.info("Server started", { port: env.PORT });
