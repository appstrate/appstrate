import { Hono } from "hono";
import type { AppEnv } from "../types/index.ts";
import { requireAdmin } from "../middleware/guards.ts";
import {
  initiateRegistryOAuth,
  handleRegistryCallback,
  disconnectRegistry,
  getRegistryStatus,
  getAuthenticatedRegistryClient,
} from "../services/registry-auth.ts";
import { logger } from "../lib/logger.ts";
import { escapeHtml } from "../lib/html.ts";

export function createRegistryAuthRouter() {
  const router = new Hono<AppEnv>();

  // POST /api/registry/connect — initiate OAuth
  router.post("/connect", async (c) => {
    const user = c.get("user");
    try {
      const result = await initiateRegistryOAuth(user.id);
      return c.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to initiate registry OAuth";
      return c.json({ error: "REGISTRY_CONNECT_FAILED", message }, 500);
    }
  });

  // GET /api/registry/callback — OAuth callback (no auth, popup redirect)
  router.get("/callback", async (c) => {
    const error = c.req.query("error");
    if (error) {
      logger.warn("Registry OAuth callback error", { error });
      return c.html(
        `<html><body><p>OAuth error: ${escapeHtml(error)}</p><script>setTimeout(()=>window.close(),3000);</script></body></html>`,
      );
    }

    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state) {
      return c.html(
        `<html><body><p>Missing required parameters</p><script>setTimeout(()=>window.close(),3000);</script></body></html>`,
      );
    }

    try {
      await handleRegistryCallback(code, state);
      return c.html(`<html><body><script>window.close();</script></body></html>`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Registry callback failed";
      logger.error("Registry callback failed", { message });
      return c.html(
        `<html><body><p style="color:red;font-family:monospace;">Error: ${escapeHtml(message)}</p><script>setTimeout(()=>window.close(),5000);</script></body></html>`,
      );
    }
  });

  // DELETE /api/registry/disconnect
  router.delete("/disconnect", async (c) => {
    const user = c.get("user");
    try {
      await disconnectRegistry(user.id);
      return c.json({ success: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to disconnect";
      return c.json({ error: "DISCONNECT_FAILED", message }, 500);
    }
  });

  // GET /api/registry/status
  router.get("/status", async (c) => {
    const user = c.get("user");
    const status = await getRegistryStatus(user.id);
    return c.json(status);
  });

  // GET /api/registry/scopes — get user's scopes from registry
  router.get("/scopes", async (c) => {
    const user = c.get("user");
    const client = await getAuthenticatedRegistryClient(user.id);
    if (!client) {
      return c.json({ error: "NOT_CONNECTED", message: "Not connected to registry" }, 401);
    }

    try {
      const scopes = await client.getMyScopes();
      return c.json({ scopes });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to fetch scopes";
      return c.json({ error: "SCOPES_FETCH_FAILED", message }, 500);
    }
  });

  // POST /api/registry/scopes — claim a scope
  router.post("/scopes", requireAdmin(), async (c) => {
    const user = c.get("user");
    const client = await getAuthenticatedRegistryClient(user.id);
    if (!client) {
      return c.json({ error: "NOT_CONNECTED", message: "Not connected to registry" }, 401);
    }

    const body = await c.req.json<{ name?: string }>();
    if (!body.name?.trim()) {
      return c.json({ error: "VALIDATION_ERROR", message: "Scope name is required" }, 400);
    }

    try {
      const scope = await client.claimScope(body.name.trim());
      return c.json({ scope }, 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to claim scope";
      return c.json({ error: "CLAIM_SCOPE_FAILED", message }, 500);
    }
  });

  return router;
}
