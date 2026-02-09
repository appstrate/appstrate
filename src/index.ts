import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { loadFlows } from "./services/flow-loader.ts";
import { createFlowsRouter } from "./routes/flows.ts";
import { createExecutionsRouter } from "./routes/executions.ts";
import authRouter from "./routes/auth.ts";

const app = new Hono();

// Middleware
app.use("*", cors());

// Auth middleware (MVP: static bearer token)
app.use("/api/*", async (c, next) => {
  const authToken = process.env.AUTH_TOKEN;
  if (!authToken) {
    // No token configured = no auth required (dev mode)
    return next();
  }
  const header = c.req.header("Authorization");
  if (!header || header !== `Bearer ${authToken}`) {
    return c.json({ error: "UNAUTHORIZED", message: "Token invalide ou manquant" }, 401);
  }
  return next();
});

// Auth middleware for /auth/* routes (all are API calls now)
app.use("/auth/*", async (c, next) => {
  const authToken = process.env.AUTH_TOKEN;
  if (!authToken) return next();
  const header = c.req.header("Authorization");
  if (!header || header !== `Bearer ${authToken}`) {
    return c.json({ error: "UNAUTHORIZED", message: "Token invalide ou manquant" }, 401);
  }
  return next();
});

// Load flows at startup
console.log("Loading flows...");
const flows = await loadFlows();
console.log(`${flows.size} flow(s) loaded.`);

// Routes
const flowsRouter = createFlowsRouter(flows);
const executionsRouter = createExecutionsRouter(flows);

app.route("/api/flows", flowsRouter);
app.route("/api", executionsRouter);
app.route("/auth", authRouter);

// Static files for UI
app.use("/*", serveStatic({ root: "./public" }));

// Start server
const port = parseInt(process.env.PORT || "3000", 10);

export default {
  port,
  fetch: app.fetch,
  idleTimeout: 255, // seconds — prevent Bun from killing long SSE connections
};

console.log(`OpenFlows running on http://localhost:${port}`);
