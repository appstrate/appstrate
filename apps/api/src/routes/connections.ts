// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types/index.ts";
import { getItemId } from "./packages.ts";
import { logger } from "../lib/logger.ts";
import { escapeHtml } from "../lib/html.ts";
import { ApiError, forbidden, invalidRequest, internalError, parseBody } from "../lib/errors.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import {
  listActorConnections,
  initiateConnection,
  handleCallback,
  handleOAuth1CallbackAndSave,
  saveApiKeyConnection,
  saveCredentialsConnection,
  getAvailableProvidersWithStatus,
  disconnectProvider,
  disconnectConnectionById,
  getProviderAuthMode,
} from "../services/connection-manager/index.ts";
import { getDefaultProfileId, getAccessibleProfile } from "../services/connection-profiles.ts";
import { getActor } from "../lib/actor.ts";
import type { Actor } from "../lib/actor.ts";
import { isProviderEnabled } from "@appstrate/connect";
import { db } from "@appstrate/db/client";
import type { Context } from "hono";

async function resolveProfileId(c: Context<AppEnv>, actor: Actor): Promise<string> {
  const profileId = c.req.query("profileId");
  if (profileId) {
    const parsed = z.uuid().safeParse(profileId);
    if (!parsed.success) {
      throw invalidRequest("Invalid profileId format", "profileId");
    }
    return parsed.data;
  }
  return getDefaultProfileId(actor);
}

export function createConnectionsRouter() {
  const router = new Hono<AppEnv>();

  // GET /api/connections — list connections for current actor's profile
  router.get("/", async (c) => {
    const actor = getActor(c);
    const orgId = c.get("orgId");
    const profileId = await resolveProfileId(c, actor);

    // Validate ownership — user can use their own profiles or org profiles
    const profile = await getAccessibleProfile(profileId, actor, orgId);
    if (!profile) {
      throw forbidden("Cannot view connections for a profile you do not own");
    }

    const connections = await listActorConnections(profileId, orgId);
    return c.json({ connections });
  });

  // POST /api/connections/connect/:provider — initiate OAuth or return authUrl
  router.post(
    "/connect/:scope{@[^/]+}/:name",
    requirePermission("connections", "connect"),
    async (c) => {
      const provider = getItemId(c);
      const actor = getActor(c);
      const orgId = c.get("orgId");

      if (!(await isProviderEnabled(db, orgId, provider))) {
        throw forbidden(`Provider '${provider}' is not configured`);
      }

      try {
        const body = parseBody(
          z.object({
            scopes: z.array(z.string()).optional(),
            profileId: z.uuid().optional(),
          }),
          await c.req.json(),
        );
        const { scopes, profileId } = body;

        const effectiveProfileId = profileId ?? (await resolveProfileId(c, actor));

        // Validate ownership — user can use their own profiles or org profiles
        const profile = await getAccessibleProfile(effectiveProfileId, actor, orgId);
        if (!profile) {
          throw forbidden("Cannot connect on a profile you do not own");
        }

        const result = await initiateConnection(provider, orgId, actor, effectiveProfileId, scopes);
        return c.json({ authUrl: result.authUrl, state: result.state });
      } catch (err: unknown) {
        if (err instanceof ApiError) throw err;
        throw internalError();
      }
    },
  );

  // POST /api/connections/connect/:provider/api-key — create an API key connection
  router.post(
    "/connect/:scope{@[^/]+}/:name/api-key",
    requirePermission("connections", "connect"),
    async (c) => {
      const provider = getItemId(c);
      const actor = getActor(c);
      const orgId = c.get("orgId");

      if (!(await isProviderEnabled(db, orgId, provider))) {
        throw forbidden(`Provider '${provider}' is not configured`);
      }

      try {
        const body = await c.req.json();
        const data = parseBody(
          z.object({
            apiKey: z.string().min(1, "API key is required"),
            profileId: z.uuid().optional(),
          }),
          body,
          "apiKey",
        );
        const profileId = data.profileId ?? (await getDefaultProfileId(actor));

        // Validate ownership — user can use their own profiles or org profiles
        const ownedProfile = await getAccessibleProfile(profileId, actor, orgId);
        if (!ownedProfile) {
          throw forbidden("Cannot connect on a profile you do not own");
        }

        await saveApiKeyConnection(provider, data.apiKey.trim(), profileId, orgId);
        return c.json({ success: true });
      } catch (err: unknown) {
        if (err instanceof ApiError) throw err;
        throw internalError();
      }
    },
  );

  // POST /api/connections/connect/:provider/credentials — save generic credentials (basic/custom providers)
  router.post(
    "/connect/:scope{@[^/]+}/:name/credentials",
    requirePermission("connections", "connect"),
    async (c) => {
      const provider = getItemId(c);
      const actor = getActor(c);
      const orgId = c.get("orgId");

      if (!(await isProviderEnabled(db, orgId, provider))) {
        throw forbidden(`Provider '${provider}' is not configured`);
      }

      try {
        const body = await c.req.json();
        const data = parseBody(
          z.object({
            credentials: z.record(z.string(), z.string()),
            profileId: z.uuid().optional(),
          }),
          body,
          "credentials",
        );

        // Resolve the auth mode from the provider
        const authMode = await getProviderAuthMode(provider, orgId);
        const mode = authMode === "basic" ? "basic" : "custom";

        const profileId = data.profileId ?? (await getDefaultProfileId(actor));

        // Validate ownership — user can use their own profiles or org profiles
        const ownedProfile = await getAccessibleProfile(profileId, actor, orgId);
        if (!ownedProfile) {
          throw forbidden("Cannot connect on a profile you do not own");
        }

        await saveCredentialsConnection(provider, mode, data.credentials, profileId, orgId);
        return c.json({ success: true });
      } catch (err: unknown) {
        if (err instanceof ApiError) throw err;
        throw internalError();
      }
    },
  );

  // GET /api/connections/callback — OAuth2/OAuth1 callback (detects flow type, exchanges for token, closes popup)
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

  // GET /api/connections/integrations — list all available providers with connection status for current actor
  router.get("/integrations", async (c) => {
    const actor = getActor(c);
    const orgId = c.get("orgId");
    const profileId = await resolveProfileId(c, actor);

    // Validate ownership — user can use their own profiles or org profiles
    const profile = await getAccessibleProfile(profileId, actor, orgId);
    if (!profile) {
      throw forbidden("Cannot view integrations for a profile you do not own");
    }

    const integrations = await getAvailableProvidersWithStatus(profileId, orgId);
    return c.json({ integrations });
  });

  // DELETE /api/connections/:provider — disconnect a provider for current actor
  // If ?connectionId is provided, deletes only that specific connection.
  // Otherwise, deletes ALL connections for the provider on the profile.
  router.delete(
    "/:scope{@[^/]+}/:name",
    requirePermission("connections", "disconnect"),
    async (c) => {
      const provider = getItemId(c);
      const actor = getActor(c);
      const connectionId = c.req.query("connectionId");
      try {
        if (connectionId) {
          await disconnectConnectionById(connectionId, actor);
        } else {
          const profileId = await resolveProfileId(c, actor);

          // Validate ownership — user can use their own profiles or org profiles
          const orgId = c.get("orgId");
          const profile = await getAccessibleProfile(profileId, actor, orgId);
          if (!profile) {
            throw forbidden("Cannot disconnect from a profile you do not own");
          }
          await disconnectProvider(provider, profileId, orgId);
        }
        return c.json({ success: true });
      } catch (err) {
        if (err instanceof ApiError) throw err;
        throw internalError();
      }
    },
  );

  return router;
}
