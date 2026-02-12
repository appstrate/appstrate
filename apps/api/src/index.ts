import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { supabase } from "./lib/supabase.ts";
import { loadFlows } from "./services/flow-loader.ts";
import { markOrphanExecutionsFailed } from "./services/state.ts";
import { initScheduler, shutdownScheduler } from "./services/scheduler.ts";
import { createFlowsRouter } from "./routes/flows.ts";
import { createExecutionsRouter } from "./routes/executions.ts";
import { createSchedulesRouter } from "./routes/schedules.ts";
import { createUserFlowsRouter } from "./routes/user-flows.ts";
import authRouter from "./routes/auth.ts";

type AppEnv = {
  Variables: {
    user: { id: string };
  };
};

const app = new Hono<AppEnv>();

// Middleware
app.use("*", cors());

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

// Load flows at startup
console.log("Loading flows...");
const flows = await loadFlows();
console.log(`${flows.size} flow(s) loaded.`);

// Clean up orphaned executions from previous server runs
try {
  const orphanCount = await markOrphanExecutionsFailed();
  if (orphanCount > 0) {
    console.log(`Marked ${orphanCount} orphaned execution(s) as failed.`);
  }
} catch (err) {
  console.warn("Could not clean orphaned executions:", err);
}

// Initialize scheduler
try {
  await initScheduler(flows);
} catch (err) {
  console.warn("Could not initialize scheduler:", err);
}

// Graceful shutdown
const shutdown = async () => {
  console.log("Shutting down...");
  shutdownScheduler();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

// Routes
const userFlowsRouter = createUserFlowsRouter({ flows });
const flowsRouter = createFlowsRouter(flows);
const executionsRouter = createExecutionsRouter(flows);
const schedulesRouter = createSchedulesRouter(flows);

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

console.log(`Appstrate running on http://localhost:${port}`);
