import { Hono } from "hono";
import type { AppEnv } from "../types/index.ts";
import { logger } from "../lib/logger.ts";
import { escapeHtml } from "../lib/html.ts";
import {
  listUserConnections,
  initiateConnection,
  handleCallback,
  handleOAuth1CallbackAndSave,
  saveApiKeyConnection,
  saveCredentialsConnection,
  getIntegrationsWithStatus,
  disconnectProvider,
  disconnectConnectionById,
  getProviderAuthMode,
} from "../services/connection-manager.ts";
import { getEffectiveProfileId } from "../services/connection-profiles.ts";
import { isProviderEnabled } from "@appstrate/connect";
import { db } from "../lib/db.ts";

const router = new Hono<AppEnv>();

// GET /auth/connections — list connections for current user's profile
router.get("/connections", async (c) => {
  const user = c.get("user");
  const profileId = c.req.query("profileId") ?? (await getEffectiveProfileId(user.id));
  const connections = await listUserConnections(profileId);
  return c.json({ connections });
});

// POST /auth/connect/:provider — initiate OAuth or return authUrl
router.post("/connect/:scope{@[^/]+}/:name", async (c) => {
  const provider = `${c.req.param("scope")}/${c.req.param("name")}`;
  const user = c.get("user");
  const orgId = c.get("orgId");

  if (!(await isProviderEnabled(db, orgId, provider))) {
    return c.json(
      { error: "PROVIDER_NOT_ENABLED", message: `Provider '${provider}' is not configured` },
      403,
    );
  }

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
router.post("/connect/:scope{@[^/]+}/:name/api-key", async (c) => {
  const provider = `${c.req.param("scope")}/${c.req.param("name")}`;
  const user = c.get("user");
  const orgId = c.get("orgId");

  if (!(await isProviderEnabled(db, orgId, provider))) {
    return c.json(
      { error: "PROVIDER_NOT_ENABLED", message: `Provider '${provider}' is not configured` },
      403,
    );
  }

  try {
    const body = await c.req.json<{ apiKey?: string; profileId?: string }>();
    if (!body.apiKey || !body.apiKey.trim()) {
      return c.json({ error: "VALIDATION_ERROR", message: "API key is required" }, 400);
    }
    const profileId = body.profileId ?? (await getEffectiveProfileId(user.id));
    await saveApiKeyConnection(provider, body.apiKey.trim(), profileId);
    return c.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to create API key connection";
    return c.json({ error: "API_KEY_CONNECTION_FAILED", message }, 500);
  }
});

// POST /auth/connect/:provider/credentials — save generic credentials (basic/custom providers)
router.post("/connect/:scope{@[^/]+}/:name/credentials", async (c) => {
  const provider = `${c.req.param("scope")}/${c.req.param("name")}`;
  const user = c.get("user");
  const orgId = c.get("orgId");

  if (!(await isProviderEnabled(db, orgId, provider))) {
    return c.json(
      { error: "PROVIDER_NOT_ENABLED", message: `Provider '${provider}' is not configured` },
      403,
    );
  }

  try {
    const body = await c.req.json<{ credentials?: Record<string, string>; profileId?: string }>();
    if (!body.credentials || typeof body.credentials !== "object") {
      return c.json({ error: "VALIDATION_ERROR", message: "Field 'credentials' is required" }, 400);
    }

    // Resolve the auth mode from the provider
    const authMode = await getProviderAuthMode(provider, orgId);
    const mode = authMode === "basic" ? "basic" : "custom";

    const profileId = body.profileId ?? (await getEffectiveProfileId(user.id));
    await saveCredentialsConnection(provider, mode, body.credentials, profileId);
    return c.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to save credentials";
    return c.json({ error: "CREDENTIALS_FAILED", message }, 500);
  }
});

// GET /auth/callback — OAuth2/OAuth1 callback (detects flow type, exchanges for token, closes popup)
router.get("/callback", async (c) => {
  const error = c.req.query("error");
  if (error) {
    logger.warn("OAuth callback received error", { error });
    return c.html(
      `<html><body><p>OAuth error: ${escapeHtml(error)}</p><script>setTimeout(()=>window.close(),3000);</script></body></html>`,
    );
  }

  // OAuth1 callback: oauth_token + oauth_verifier
  const oauthToken = c.req.query("oauth_token");
  const oauthVerifier = c.req.query("oauth_verifier");
  if (oauthToken && oauthVerifier) {
    try {
      await handleOAuth1CallbackAndSave(oauthToken, oauthVerifier);
      logger.info("OAuth1 callback success", { oauthToken });
      return c.html(`<html><body><script>window.close();</script></body></html>`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "OAuth1 callback failed";
      logger.error("OAuth1 callback failed", { message });
      return c.html(
        `<html><body><p style="color:red;font-family:monospace;">Error: ${escapeHtml(message)}</p><script>setTimeout(()=>window.close(),5000);</script></body></html>`,
      );
    }
  }

  // OAuth2 callback: code + state
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) {
    logger.warn("OAuth callback missing required params", {
      hasCode: !!code,
      hasState: !!state,
      hasOauthToken: !!oauthToken,
    });
    return c.html(
      `<html><body><p>Missing required parameters</p><script>setTimeout(()=>window.close(),3000);</script></body></html>`,
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
      `<html><body><p style="color:red;font-family:monospace;">Error: ${escapeHtml(message)}</p><script>setTimeout(()=>window.close(),5000);</script></body></html>`,
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
// If ?connectionId is provided, deletes only that specific connection.
// Otherwise, deletes ALL connections for the provider on the profile.
router.delete("/connections/:scope{@[^/]+}/:name", async (c) => {
  const provider = `${c.req.param("scope")}/${c.req.param("name")}`;
  const user = c.get("user");
  const connectionId = c.req.query("connectionId");
  try {
    if (connectionId) {
      await disconnectConnectionById(connectionId, user.id);
    } else {
      const profileId = c.req.query("profileId") ?? (await getEffectiveProfileId(user.id));
      await disconnectProvider(provider, profileId);
    }
    return c.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to delete connection";
    return c.json({ error: "DELETE_FAILED", message }, 500);
  }
});

export default router;
