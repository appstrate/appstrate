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
import { createFlowsRouter } from "./routes/flows.ts";
import { createExecutionsRouter } from "./routes/executions.ts";
import { createSchedulesRouter } from "./routes/schedules.ts";
import { createUserFlowsRouter } from "./routes/user-flows.ts";
import { createShareRouter } from "./routes/share.ts";
import { createProvidersRouter } from "./routes/providers.ts";
import { createApiKeysRouter } from "./routes/api-keys.ts";
import { createProxiesRouter } from "./routes/proxies.ts";
import { createInternalRouter } from "./routes/internal.ts";
import { createConnectionProfilesRouter } from "./routes/connection-profiles.ts";
import { createNotificationsRouter } from "./routes/notifications.ts";
import { createMarketplaceRouter } from "./routes/marketplace.ts";
import { createPackagesRouter } from "./routes/packages.ts";
import { createRealtimeRouter } from "./routes/realtime.ts";
import { createRegistryAuthRouter } from "./routes/registry-auth.ts";
import healthRouter from "./routes/health.ts";
import authRouter from "./routes/auth.ts";
import orgsRouter from "./routes/organizations.ts";
import profileRouter from "./routes/profile.ts";
import invitationsRouter from "./routes/invitations.ts";
import welcomeRouter from "./routes/welcome.ts";
import { swaggerUI } from "@hono/swagger-ui";
import { openApiSpec } from "./openapi/index.ts";
import type { AppEnv } from "./types/index.ts";

// Fail-fast: validate all env vars at startup
const env = getEnv();

const app = new Hono<AppEnv>();

// Middleware
const trustedOrigins = env.TRUSTED_ORIGINS;

app.use("*", cors({ origin: trustedOrigins, credentials: true }));

// Health check — before auth middleware (no auth required)
app.route("/", healthRouter);

// OpenAPI docs — public (before auth middleware)
app.get("/api/openapi.json", (c) => c.json(openApiSpec));
app.get("/api/docs", swaggerUI({ url: "/api/openapi.json" }));

// Shutdown gate — reject new write requests during graceful shutdown
let shuttingDown = false;

app.use("*", async (c, next) => {
  if (shuttingDown && c.req.method === "POST") {
    return c.json({ error: "SHUTTING_DOWN", message: "Server is shutting down" }, 503);
  }
  return next();
});

// Mount Better Auth handler — handles signup, signin, session, etc.
app.on(["POST", "GET"], "/api/auth/*", (c) => {
  return auth.handler(c.req.raw);
});

// Auth middleware: verify Bearer API key OR Better Auth session (cookie-based)
app.use("*", async (c, next) => {
  const path = c.req.path;
  if (!path.startsWith("/api/") && !path.startsWith("/auth/")) return next();
  // Better Auth endpoints are handled above
  if (path.startsWith("/api/auth/")) return next();
  // Realtime SSE endpoints handle their own auth (cookie-based, no X-Org-Id header)
  if (path.startsWith("/api/realtime/")) return next();
  // OAuth callback is a redirect from the provider — no session
  if (path === "/auth/callback") return next();
  // Registry OAuth callback is a redirect — no session
  if (path === "/api/registry/callback") return next();
  // OpenAPI docs are public
  if (path === "/api/docs" || path === "/api/openapi.json") return next();

  // Try Bearer API key first
  const authHeader = c.req.header("Authorization");
  if (authHeader?.startsWith("Bearer ask_")) {
    const rawKey = authHeader.slice(7); // "Bearer ".length
    const keyInfo = await validateApiKey(rawKey);
    if (!keyInfo) {
      return c.json({ error: "UNAUTHORIZED", message: "Invalid or expired API key" }, 401);
    }
    c.set("user", { id: keyInfo.userId, email: keyInfo.email, name: keyInfo.name });
    c.set("orgId", keyInfo.orgId);
    c.set("orgSlug", keyInfo.orgSlug);
    c.set("orgRole", "admin");
    c.set("authMethod", "api_key");
    c.set("apiKeyId", keyInfo.keyId);
    return next();
  }

  // Fallback: cookie session
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session?.user) {
    return c.json({ error: "UNAUTHORIZED", message: "Invalid or missing session" }, 401);
  }
  c.set("user", {
    id: session.user.id,
    email: session.user.email ?? "",
    name: session.user.name ?? "",
  });
  c.set("authMethod", "session");

  // Ensure the user has a default connection profile
  ensureDefaultProfile(session.user.id).catch((err) => {
    logger.warn("Failed to ensure default profile", {
      userId: session.user.id,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  return next();
});

// Org context middleware: require X-Org-Id for all /api/* and /auth/* routes
// EXCEPT: /api/orgs (list/create without org context), /health, /share/*, /internal/*
app.use("*", async (c, next) => {
  const path = c.req.path;

  // Skip org context for routes that don't need it
  if (!path.startsWith("/api/") && !path.startsWith("/auth/")) return next();
  if (path.startsWith("/api/auth/")) return next();
  if (path.startsWith("/api/realtime/")) return next();
  if (path === "/auth/callback") return next();
  // Registry routes are user-scoped, not org-scoped
  if (path === "/api/registry/callback") return next();
  if (path.startsWith("/api/registry/")) return next();
  // OpenAPI docs are public
  if (path === "/api/docs" || path === "/api/openapi.json") return next();
  if (path === "/api/orgs" || path === "/api/orgs/") return next();
  // Allow /api/orgs/:orgId/* routes (they handle their own auth)
  if (path.startsWith("/api/orgs/")) return next();
  // Profile routes are user-scoped, not org-scoped
  if (path === "/api/profile" || path === "/api/profile/") return next();
  if (path === "/api/profiles/batch") return next();
  // Welcome setup is user-scoped, not org-scoped
  if (path === "/api/welcome/setup") return next();
  // API key auth already resolved orgId
  if (c.get("authMethod") === "api_key") return next();

  return requireOrgContext()(c, next);
});

// Boot: load system resources, init services, clean up orphans
await boot();

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
app.route("/api/marketplace", createMarketplaceRouter());
app.route("/api/registry", createRegistryAuthRouter());
app.route("/api/providers", createProvidersRouter());
app.route("/api/api-keys", createApiKeysRouter());
app.route("/api/proxies", createProxiesRouter());
app.route("/api/connection-profiles", createConnectionProfilesRouter());
app.route("/api", profileRouter);
app.route("/api/realtime", createRealtimeRouter());
app.route("/auth", authRouter);

// Public invitation routes (no auth required — path doesn't start with /api/ or /auth/)
app.route("/invite", invitationsRouter);

// Public share routes (no JWT required — path doesn't start with /api/ or /auth/)
const shareRouter = createShareRouter();
app.route("/share", shareRouter);

// Welcome route (authenticated, cookie-based — org context not required)
app.route("/api", welcomeRouter);

// Internal routes (container-to-host, auth via execution token — no JWT)
const internalRouter = createInternalRouter();
app.route("/internal", internalRouter);

// Static files for UI
app.use("/*", serveStatic({ root: "./apps/web/dist" }));

// SPA fallback — serve index.html for client-side routes
app.get("/*", serveStatic({ root: "./apps/web/dist", path: "index.html" }));

// Start server
export default {
  port: env.PORT,
  fetch: app.fetch,
  idleTimeout: 255,
};

logger.info("Server started", { port: env.PORT });
