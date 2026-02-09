import { Hono } from "hono";
import { listConnections, createConnectSession } from "../services/nango.ts";

const router = new Hono();

// GET /auth/connections — list OAuth connections
router.get("/connections", async (c) => {
  const connections = await listConnections();
  return c.json({ connections });
});

// POST /auth/connect/:provider — create a connect session (returns connect_link for popup)
router.post("/connect/:provider", async (c) => {
  const provider = c.req.param("provider");
  try {
    const session = await createConnectSession(provider);
    return c.json(session);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to create connect session";
    return c.json({ error: "CONNECT_SESSION_FAILED", message }, 500);
  }
});

export default router;
