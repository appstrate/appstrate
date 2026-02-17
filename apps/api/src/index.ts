import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { zipSync, type Zippable } from "fflate";
import { supabase } from "./lib/supabase.ts";
import { logger } from "./lib/logger.ts";
import { initFlowService, getBuiltInFlowCount } from "./services/flow-service.ts";
import { markOrphanExecutionsFailed } from "./services/state.ts";
import { initScheduler, shutdownScheduler } from "./services/scheduler.ts";
import { getInFlightCount, waitForInFlight } from "./services/execution-tracker.ts";
import { ensureStorageBucket } from "./services/flow-package.ts";
import { createVersionAndUpload } from "./services/flow-versions.ts";
import { createFlowsRouter } from "./routes/flows.ts";
import { createExecutionsRouter } from "./routes/executions.ts";
import { createSchedulesRouter } from "./routes/schedules.ts";
import { createUserFlowsRouter } from "./routes/user-flows.ts";
import healthRouter from "./routes/health.ts";
import authRouter from "./routes/auth.ts";
import type { AppEnv, Json } from "./types/index.ts";

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

// Ensure Supabase Storage bucket for flow packages
try {
  await ensureStorageBucket();
} catch (err) {
  logger.warn("Could not ensure storage bucket", {
    error: err instanceof Error ? err.message : String(err),
  });
}

// Migrate existing user flows: move JSONB content to ZIP packages in Storage
try {
  await migrateFlowsToStorage();
} catch (err) {
  logger.warn("Could not run flow storage migration", {
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

// --- Startup migration ---

/**
 * Idempotent migration: for user flows with JSONB skills/extensions that have a `content` field,
 * reconstruct a ZIP, upload to Storage, and strip content from DB entries.
 */
async function migrateFlowsToStorage() {
  const { data: flows } = await supabase.from("flows").select("*");
  if (!flows || flows.length === 0) return;

  let migrated = 0;

  for (const flow of flows) {
    try {
      const flowAny = flow as Record<string, unknown>;

      // Check for legacy JSONB columns with `content` field (pre-migration data)
      // After migration 006, these columns no longer exist, so this is a no-op.
      const legacySkills = ((flowAny.skills ?? []) as { id: string; name?: string; description?: string; content?: string }[]);
      const legacyExtensions = ((flowAny.extensions ?? []) as { id: string; description?: string; content?: string }[]);

      // Check if any skill or extension still has content (needs migration)
      const hasContent =
        legacySkills.some((s) => s.content !== undefined) ||
        legacyExtensions.some((e) => e.content !== undefined);

      if (!hasContent) continue;

      // Reconstruct a ZIP from manifest + prompt + skill/extension content
      const entries: Zippable = {
        "manifest.json": new TextEncoder().encode(JSON.stringify(flow.manifest, null, 2)),
        "prompt.md": new TextEncoder().encode(flow.prompt),
      };

      for (const skill of legacySkills) {
        if (skill.content) {
          entries[`skills/${skill.id}/SKILL.md`] = new TextEncoder().encode(skill.content);
        }
      }

      for (const ext of legacyExtensions) {
        if (ext.content) {
          entries[`extensions/${ext.id}.ts`] = new TextEncoder().encode(ext.content);
        }
      }

      const zipBuffer = Buffer.from(zipSync(entries, { level: 6 }));

      // Merge skills/extensions metadata into manifest.requires (source of truth)
      const manifest = flow.manifest as Record<string, unknown>;
      const requires = (manifest.requires ?? {}) as Record<string, unknown>;
      if (!requires.skills || (requires.skills as unknown[]).length === 0) {
        requires.skills = legacySkills.map((s) => ({
          id: s.id,
          ...(s.name ? { name: s.name } : {}),
          ...(s.description ? { description: s.description } : {}),
        }));
      }
      if (!requires.extensions || (requires.extensions as unknown[]).length === 0) {
        requires.extensions = legacyExtensions.map((e) => ({
          id: e.id,
          ...(e.description ? { description: e.description } : {}),
        }));
      }

      // Create version and upload ZIP
      await createVersionAndUpload(
        flow.id,
        manifest,
        flow.prompt,
        "system",
        zipBuffer,
      );

      // Update manifest in DB to include merged skills/extensions metadata
      await supabase
        .from("flows")
        .update({ manifest: manifest as Json })
        .eq("id", flow.id);

      migrated++;
    } catch (err) {
      logger.warn("Migration failed for flow, skipping", {
        flowId: flow.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (migrated > 0) {
    logger.info("Migrated user flows to Storage", { count: migrated });
  }
}
