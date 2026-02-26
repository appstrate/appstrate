import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { lt } from "drizzle-orm";
import { getEnv } from "@appstrate/env";
import { db, closeDb } from "./lib/db.ts";
import { auth } from "./lib/auth.ts";
import { oauthStates, scheduleRuns } from "@appstrate/db/schema";
import { expireOldInvitations } from "./services/invitations.ts";
import { validateApiKey, cleanupExpiredKeys } from "./services/api-keys.ts";
import { createNotifyTriggers } from "@appstrate/db/notify";
import { logger } from "./lib/logger.ts";
import { initRealtime } from "./services/realtime.ts";
import { createRealtimeRouter } from "./routes/realtime.ts";
import { initBuiltInProviders } from "@appstrate/connect";
import { initBuiltInProxies } from "./services/proxy-registry.ts";
import { ensureDefaultProfile } from "./services/connection-profiles.ts";
import { initFlowService, getBuiltInFlowCount } from "./services/flow-service.ts";
import { initBuiltInLibrary } from "./services/builtin-library.ts";
import { markOrphanExecutionsFailed } from "./services/state.ts";
import { cleanupOrphanedContainers } from "./services/docker.ts";
import { initScheduler, shutdownScheduler } from "./services/scheduler.ts";
import { getInFlightCount, waitForInFlight } from "./services/execution-tracker.ts";
import { ensureStorageBucket } from "./services/flow-package.ts";
import { ensureLibraryBucket } from "./services/library.ts";
import { requireOrgContext } from "./middleware/org-context.ts";
import { createFlowsRouter } from "./routes/flows.ts";
import { createExecutionsRouter } from "./routes/executions.ts";
import { createSchedulesRouter } from "./routes/schedules.ts";
import { createUserFlowsRouter } from "./routes/user-flows.ts";
import { createShareRouter } from "./routes/share.ts";
import { createLibraryRouter } from "./routes/library.ts";
import { createProvidersRouter } from "./routes/providers.ts";
import { createApiKeysRouter } from "./routes/api-keys.ts";
import { createProxiesRouter } from "./routes/proxies.ts";
import { createInternalRouter } from "./routes/internal.ts";
import { createConnectionProfilesRouter } from "./routes/connection-profiles.ts";
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

// Load built-in resources from DATA_DIR (if configured)
const dataDir = env.DATA_DIR;

if (dataDir) {
  // Load built-in providers from {dataDir}/providers.json + SYSTEM_PROVIDERS env var
  const providersPath = join(dataDir, "providers.json");
  try {
    const fileProviders = JSON.parse(readFileSync(providersPath, "utf-8"));
    initBuiltInProviders(fileProviders);
    logger.info("Built-in providers loaded", { count: fileProviders.length });
  } catch {
    initBuiltInProviders();
    logger.info("Built-in providers loaded (env var only)");
  }

  // Load built-in proxies from {dataDir}/proxies.json + SYSTEM_PROXIES env var
  const proxiesPath = join(dataDir, "proxies.json");
  try {
    const fileProxies = JSON.parse(readFileSync(proxiesPath, "utf-8"));
    initBuiltInProxies(fileProxies);
    logger.info("Built-in proxies loaded", { count: fileProxies.length });
  } catch {
    initBuiltInProxies();
    logger.info("Built-in proxies loaded (env var only)");
  }

  await initFlowService(dataDir);
  logger.info("Built-in flows loaded", { count: getBuiltInFlowCount() });

  await initBuiltInLibrary(dataDir);
} else {
  initBuiltInProviders(); // SYSTEM_PROVIDERS env var still loaded
  initBuiltInProxies(); // SYSTEM_PROXIES env var still loaded
  logger.info("DATA_DIR not set — built-in resources disabled");
}

// Ensure local storage directories
try {
  await ensureStorageBucket();
} catch (err) {
  logger.warn("Could not ensure storage bucket", {
    error: err instanceof Error ? err.message : String(err),
  });
}
try {
  await ensureLibraryBucket();
} catch (err) {
  logger.warn("Could not ensure library bucket", {
    error: err instanceof Error ? err.message : String(err),
  });
}

// Install NOTIFY triggers for realtime
try {
  await createNotifyTriggers(db);
  logger.info("NOTIFY triggers installed");
} catch (err) {
  logger.warn("Could not install NOTIFY triggers", {
    error: err instanceof Error ? err.message : String(err),
  });
}

// Initialize realtime LISTEN channels
try {
  await initRealtime();
} catch (err) {
  logger.warn("Could not initialize realtime LISTEN", {
    error: err instanceof Error ? err.message : String(err),
  });
}

// Clean up orphaned executions from previous server runs
try {
  const { count, executionIds } = await markOrphanExecutionsFailed();
  if (count > 0) {
    logger.info("Marked orphaned executions as failed", { count, executionIds });
  }
} catch (err) {
  logger.warn("Could not clean orphaned executions", {
    error: err instanceof Error ? err.message : String(err),
  });
}

// Clean up orphaned Docker containers/networks (best-effort, always runs)
try {
  const { containers, networks } = await cleanupOrphanedContainers();
  if (containers > 0 || networks > 0) {
    logger.info("Cleaned up orphaned Docker resources", { containers, networks });
  }
} catch (err) {
  logger.warn("Could not clean up orphaned Docker resources", {
    error: err instanceof Error ? err.message : String(err),
  });
}

// Initialize scheduler
try {
  await initScheduler();
} catch (err) {
  logger.warn("Could not initialize scheduler", {
    error: err instanceof Error ? err.message : String(err),
  });
}

// Clean up expired OAuth states
try {
  const deleted = await db.delete(oauthStates).where(lt(oauthStates.expiresAt, new Date()));
  logger.debug("Cleaned up expired OAuth states", { deleted });
} catch (err) {
  logger.warn("Could not clean up expired OAuth states", {
    error: err instanceof Error ? err.message : String(err),
  });
}

// Clean up expired invitations
try {
  const expiredCount = await expireOldInvitations();
  if (expiredCount > 0) {
    logger.info("Expired old invitations", { count: expiredCount });
  }
} catch (err) {
  logger.warn("Could not expire old invitations", {
    error: err instanceof Error ? err.message : String(err),
  });
}

// Clean up expired API keys
try {
  const expiredKeyCount = await cleanupExpiredKeys();
  if (expiredKeyCount > 0) {
    logger.info("Revoked expired API keys", { count: expiredKeyCount });
  }
} catch (err) {
  logger.warn("Could not clean up expired API keys", {
    error: err instanceof Error ? err.message : String(err),
  });
}

// Clean up old schedule_runs rows (retention: 30 days)
try {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const deleted = await db.delete(scheduleRuns).where(lt(scheduleRuns.createdAt, cutoff));
  logger.debug("Cleaned up old schedule_runs", { deleted });
} catch (err) {
  logger.warn("Could not clean up old schedule_runs", {
    error: err instanceof Error ? err.message : String(err),
  });
}

// Graceful shutdown
const SHUTDOWN_TIMEOUT_MS = 30_000;

const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info("Shutdown initiated, stopping scheduler...");
  shutdownScheduler();

  const inFlight = getInFlightCount();
  if (inFlight > 0) {
    logger.info("Waiting for in-flight executions", {
      count: inFlight,
      timeoutMs: SHUTDOWN_TIMEOUT_MS,
    });
    const drained = await waitForInFlight(SHUTDOWN_TIMEOUT_MS);
    if (!drained) {
      logger.warn("Shutdown timeout reached, forcing exit", {
        remaining: getInFlightCount(),
      });
    }
  }

  logger.info("Closing database connections...");
  await closeDb();

  logger.info("Shutdown complete");
  process.exit(0);
};
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
app.route("/api", executionsRouter);
app.route("/api", schedulesRouter);
app.route("/api/library", createLibraryRouter());
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
