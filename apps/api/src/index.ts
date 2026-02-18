import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { supabase } from "./lib/supabase.ts";
import { logger } from "./lib/logger.ts";
import { initFlowService, getBuiltInFlowCount } from "./services/flow-service.ts";
import { markOrphanExecutionsFailed } from "./services/state.ts";
import { initScheduler, shutdownScheduler } from "./services/scheduler.ts";
import { getInFlightCount, waitForInFlight } from "./services/execution-tracker.ts";
import { ensureStorageBucket } from "./services/flow-package.ts";
import { ensureFilesBucket } from "./services/file-storage.ts";
import { createFlowsRouter } from "./routes/flows.ts";
import { createExecutionsRouter } from "./routes/executions.ts";
import { createSchedulesRouter } from "./routes/schedules.ts";
import { createUserFlowsRouter } from "./routes/user-flows.ts";
import { createShareRouter } from "./routes/share.ts";
import healthRouter from "./routes/health.ts";
import authRouter from "./routes/auth.ts";
import type { AppEnv } from "./types/index.ts";

const app = new Hono<AppEnv>();

// Middleware
app.use("*", cors());

// Health check — before auth middleware (no auth required)
app.route("/", healthRouter);

// Shutdown gate — reject new write requests during graceful shutdown
let shuttingDown = false;

app.use("*", async (c, next) => {
  if (shuttingDown && c.req.method === "POST") {
    return c.json({ error: "SHUTTING_DOWN", message: "Server is shutting down" }, 503);
  }
  return next();
});

// Auth middleware: verify Supabase JWT and inject user into context
async function verifyUser(authHeader: string | undefined) {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser(token);
  if (error || !user) return null;
  return user;
}

// Single auth middleware for /api/* and /auth/* routes
app.use("*", async (c, next) => {
  const path = c.req.path;
  if (!path.startsWith("/api/") && !path.startsWith("/auth/")) return next();

  const user = await verifyUser(c.req.header("Authorization"));
  if (!user) {
    return c.json({ error: "UNAUTHORIZED", message: "Token invalide ou manquant" }, 401);
  }
  c.set("user", user);
  return next();
});

// Load built-in flows from filesystem
logger.info("Loading flows...");
await initFlowService();
logger.info("Built-in flows loaded", { count: getBuiltInFlowCount() });

// Ensure Supabase Storage buckets
try {
  await ensureStorageBucket();
} catch (err) {
  logger.warn("Could not ensure storage bucket", {
    error: err instanceof Error ? err.message : String(err),
  });
}
try {
  await ensureFilesBucket();
} catch (err) {
  logger.warn("Could not ensure execution-files bucket", {
    error: err instanceof Error ? err.message : String(err),
  });
}

// Clean up orphaned executions from previous server runs
try {
  const orphanCount = await markOrphanExecutionsFailed();
  if (orphanCount > 0) {
    logger.info("Marked orphaned executions as failed", { count: orphanCount });
  }
} catch (err) {
  logger.warn("Could not clean orphaned executions", {
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

// Clean up old schedule_runs rows (retention: 30 days)
try {
  const { data: deletedCount } = await supabase.rpc("cleanup_old_schedule_runs", {
    retention_days: 30,
  });
  if (deletedCount && deletedCount > 0) {
    logger.info("Cleaned up old schedule_runs", { deleted: deletedCount });
  }
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

app.route("/api/flows", userFlowsRouter); // Must be before flowsRouter (import/delete routes)
app.route("/api/flows", flowsRouter);
app.route("/api", executionsRouter);
app.route("/api", schedulesRouter);
app.route("/auth", authRouter);

// Public share routes (no JWT required — path doesn't start with /api/ or /auth/)
const shareRouter = createShareRouter();
app.route("/share", shareRouter);

// Static files for UI
app.use("/*", serveStatic({ root: "./apps/web/dist" }));

// SPA fallback — serve index.html for client-side routes
app.get("/*", serveStatic({ root: "./apps/web/dist", path: "index.html" }));

// Start server
const port = parseInt(process.env.PORT || "3000", 10);

export default {
  port,
  fetch: app.fetch,
  idleTimeout: 255,
};

logger.info("Server started", { port });
