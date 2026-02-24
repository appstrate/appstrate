import { Hono } from "hono";
import type { AppEnv } from "../types/index.ts";
import { logger } from "../lib/logger.ts";
import {
  listUserConnections,
  initiateConnection,
  handleCallback,
  saveApiKeyConnection,
  saveCredentialsConnection,
  getIntegrationsWithStatus,
  disconnectProvider,
  getProviderAuthMode,
} from "../services/connection-manager.ts";
import { getEffectiveProfileId } from "../services/connection-profiles.ts";

const router = new Hono<AppEnv>();

// GET /auth/connections — list connections for current user's profile
router.get("/connections", async (c) => {
  const user = c.get("user");
  const profileId = c.req.query("profileId") ?? (await getEffectiveProfileId(user.id));
  const connections = await listUserConnections(profileId);
  return c.json({ connections });
});

// POST /auth/connect/:provider — initiate OAuth or return authUrl
router.post("/connect/:provider", async (c) => {
  const provider = c.req.param("provider");
  const user = c.get("user");
  const orgId = c.get("orgId");

  try {
    let scopes: string[] | undefined;
    let profileId: string | undefined;
    try {
      const body = await c.req.json<{ scopes?: string[]; profileId?: string }>();
      scopes = body.scopes;
      profileId = body.profileId;
    } catch {
      // No body or invalid JSON — OK, scopes and profileId are optional
    }

    const effectiveProfileId = profileId ?? (await getEffectiveProfileId(user.id));
    const result = await initiateConnection(provider, orgId, user.id, effectiveProfileId, scopes);
    return c.json({ authUrl: result.authUrl, state: result.state });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to create connect session";
    return c.json({ error: "CONNECT_SESSION_FAILED", message }, 500);
  }
});

// POST /auth/connect/:provider/api-key — create an API key connection
router.post("/connect/:provider/api-key", async (c) => {
  const provider = c.req.param("provider");
  const user = c.get("user");
  const orgId = c.get("orgId");
  try {
    const body = await c.req.json<{ apiKey?: string; profileId?: string }>();
    if (!body.apiKey || !body.apiKey.trim()) {
      return c.json({ error: "VALIDATION_ERROR", message: "API key is required" }, 400);
    }
    const profileId = body.profileId ?? (await getEffectiveProfileId(user.id));
    await saveApiKeyConnection(provider, body.apiKey.trim(), profileId, orgId);
    return c.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to create API key connection";
    return c.json({ error: "API_KEY_CONNECTION_FAILED", message }, 500);
  }
});

// POST /auth/connect/:provider/credentials — save generic credentials (basic/custom providers)
router.post("/connect/:provider/credentials", async (c) => {
  const provider = c.req.param("provider");
  const user = c.get("user");
  const orgId = c.get("orgId");
  try {
    const body = await c.req.json<{ credentials?: Record<string, string>; profileId?: string }>();
    if (!body.credentials || typeof body.credentials !== "object") {
      return c.json({ error: "VALIDATION_ERROR", message: "Field 'credentials' is required" }, 400);
    }

    // Resolve the auth mode from the provider
    const authMode = await getProviderAuthMode(provider, orgId);
    const mode = authMode === "basic" ? "basic" : "custom";

    const profileId = body.profileId ?? (await getEffectiveProfileId(user.id));
    await saveCredentialsConnection(provider, mode, body.credentials, profileId, orgId);
    return c.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to save credentials";
    return c.json({ error: "CREDENTIALS_FAILED", message }, 500);
  }
});

// GET /auth/callback — OAuth2 callback (receives code+state, exchanges for token, closes popup)
router.get("/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const error = c.req.query("error");

  if (error) {
    logger.warn("OAuth callback received error", { error });
    return c.html(
      `<html><body><p>OAuth error: ${error}</p><script>setTimeout(()=>window.close(),3000);</script></body></html>`,
    );
  }

  if (!code || !state) {
    logger.warn("OAuth callback missing code or state", { hasCode: !!code, hasState: !!state });
    return c.html(
      `<html><body><p>Missing code or state</p><script>setTimeout(()=>window.close(),3000);</script></body></html>`,
    );
  }

  try {
    await handleCallback(code, state);
    logger.info("OAuth callback success", { state });
    return c.html(`<html><body><script>window.close();</script></body></html>`);
  } catch (err) {
    const message = err instanceof Error ? err.message : "OAuth callback failed";
    logger.error("OAuth callback failed", { message });
    return c.html(
      `<html><body><p style="color:red;font-family:monospace;">Error: ${message}</p><script>setTimeout(()=>window.close(),5000);</script></body></html>`,
    );
  }
});

// GET /auth/integrations — list all integrations with connection status for current user
router.get("/integrations", async (c) => {
  const user = c.get("user");
  const orgId = c.get("orgId");
  const profileId = c.req.query("profileId") ?? (await getEffectiveProfileId(user.id));
  const integrations = await getIntegrationsWithStatus(profileId, orgId);
  return c.json({ integrations });
});

// DELETE /auth/connections/:provider — disconnect a service for current user
router.delete("/connections/:provider", async (c) => {
  const provider = c.req.param("provider");
  const user = c.get("user");
  try {
    const profileId = c.req.query("profileId") ?? (await getEffectiveProfileId(user.id));
    await disconnectProvider(provider, profileId);
    return c.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to delete connection";
    return c.json({ error: "DELETE_FAILED", message }, 500);
  }
});

export default router;
