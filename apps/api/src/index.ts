import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { createBunWebSocket } from "hono/bun";
import { loadFlows } from "./services/flow-loader.ts";
import { markOrphanExecutionsFailed } from "./services/state.ts";
import { createFlowsRouter } from "./routes/flows.ts";
import { createExecutionsRouter } from "./routes/executions.ts";
import authRouter from "./routes/auth.ts";
import * as ws from "./ws.ts";

const app = new Hono();
const { upgradeWebSocket, websocket } = createBunWebSocket();

// Middleware
app.use("*", cors());

// WebSocket route (before auth middleware — auth via query param)
app.get(
  "/ws",
  upgradeWebSocket((c) => {
    let connectionId: string | null = null;
    return {
      onOpen(_evt, wsCtx) {
        const token = new URL(c.req.url).searchParams.get("token") || "";
        const authToken = process.env.AUTH_TOKEN;
        if (authToken && token !== authToken) {
          wsCtx.close(1008, "Unauthorized");
          return;
        }
        connectionId = ws.addConnection(wsCtx);
      },
      onMessage(evt) {
        if (!connectionId) return;
        try {
          const msg = JSON.parse(String(evt.data));
          if (msg.type === "subscribe") ws.subscribe(connectionId, msg.channel);
          else if (msg.type === "unsubscribe") ws.unsubscribe(connectionId, msg.channel);
          else if (msg.type === "ping") ws.send(connectionId, { type: "pong" });
        } catch {
          // Invalid JSON — ignore
        }
      },
      onClose() {
        if (connectionId) ws.removeConnection(connectionId);
      },
    };
  }),
);

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

// Clean up orphaned executions from previous server runs
try {
  const orphanCount = await markOrphanExecutionsFailed();
  if (orphanCount > 0) {
    console.log(`Marked ${orphanCount} orphaned execution(s) as failed.`);
  }
} catch (err) {
  console.warn("Could not clean orphaned executions:", err);
}

// Routes
const flowsRouter = createFlowsRouter(flows);
const executionsRouter = createExecutionsRouter(flows);

app.route("/api/flows", flowsRouter);
app.route("/api", executionsRouter);
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
  websocket,
  idleTimeout: 255, // seconds — prevent Bun from killing long SSE/WS connections
};

console.log(`OpenFlows running on http://localhost:${port}`);
