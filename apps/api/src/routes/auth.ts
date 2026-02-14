import { Hono } from "hono";
import type { AppEnv } from "../types/index.ts";
import {
  listConnections,
  createConnectSession,
  createApiKeyConnection,
  getIntegrationsWithStatus,
  deleteConnection,
} from "../services/nango.ts";

const router = new Hono<AppEnv>();

// GET /auth/connections — list OAuth connections for current user
router.get("/connections", async (c) => {
  const user = c.get("user");
  const connections = await listConnections(user.id);
  return c.json({ connections });
});

// POST /auth/connect/:provider — create a connect session (returns connect_link for popup)
router.post("/connect/:provider", async (c) => {
  const provider = c.req.param("provider");
  const user = c.get("user");
  try {
    const session = await createConnectSession(provider, user.id);
    return c.json(session);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to create connect session";
    return c.json({ error: "CONNECT_SESSION_FAILED", message }, 500);
  }
});

// POST /auth/connect/:provider/api-key — create an API key connection
router.post("/connect/:provider/api-key", async (c) => {
  const provider = c.req.param("provider");
  const user = c.get("user");
  try {
    const body = await c.req.json<{ apiKey?: string }>();
    if (!body.apiKey || !body.apiKey.trim()) {
      return c.json({ error: "VALIDATION_ERROR", message: "API key is required" }, 400);
    }
    await createApiKeyConnection(provider, body.apiKey.trim(), user.id);
    return c.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to create API key connection";
    return c.json({ error: "API_KEY_CONNECTION_FAILED", message }, 500);
  }
});

// GET /auth/integrations — list all integrations with connection status for current user
router.get("/integrations", async (c) => {
  const user = c.get("user");
  const integrations = await getIntegrationsWithStatus(user.id);
  return c.json({ integrations });
});

// DELETE /auth/connections/:provider — disconnect a service for current user
router.delete("/connections/:provider", async (c) => {
  const provider = c.req.param("provider");
  const user = c.get("user");
  try {
    await deleteConnection(provider, user.id);
    return c.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to delete connection";
    return c.json({ error: "DELETE_FAILED", message }, 400);
  }
});

export default router;
