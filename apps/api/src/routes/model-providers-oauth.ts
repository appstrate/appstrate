// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { z } from "zod";
import { getEnv } from "@appstrate/env";
import type { AppEnv } from "../types/index.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import { requireAppContext } from "../middleware/app-context.ts";
import {
  initiateOAuthModelProviderConnection,
  handleOAuthModelProviderCallback,
  importOAuthModelProviderConnection,
} from "../services/oauth-model-providers/oauth-flow.ts";
import { isOAuthModelProvider } from "../services/oauth-model-providers/registry.ts";
import { invalidRequest, parseBody } from "../lib/errors.ts";
import { recordAuditFromContext } from "../services/audit.ts";

const initiateBody = z.object({
  providerPackageId: z
    .string()
    .min(1)
    .refine(
      (id) => isOAuthModelProvider(id),
      "providerPackageId must be a registered OAuth model provider",
    ),
  label: z.string().min(1, "label is required").max(120),
});

/**
 * Body shape posted by `appstrate connect <provider>` after the CLI has
 * completed the loopback OAuth dance against the provider's authorization
 * server. The CLI funnels the `OAuthCredentials` returned by `pi-ai` into
 * this contract; everything except `accessToken`/`refreshToken`/`label` is
 * advisory and re-derived server-side when possible.
 */
const importBody = z.object({
  providerPackageId: z
    .string()
    .min(1)
    .refine(
      (id) => isOAuthModelProvider(id),
      "providerPackageId must be a registered OAuth model provider",
    ),
  label: z.string().min(1, "label is required").max(120),
  accessToken: z.string().min(1, "accessToken is required"),
  refreshToken: z.string().min(1, "refreshToken is required"),
  /** Unix ms timestamp; CLI converts pi-ai's `expires` field as-is. */
  expiresAt: z.number().int().positive().optional().nullable(),
  /** Optional — when absent the server falls back to the user's default profile. */
  connectionProfileId: z.string().uuid().optional(),
  /** Claude-only: subscription tier from the token response body. */
  subscriptionType: z.string().max(40).optional(),
  /** Account email; Codex re-derives from JWT, Claude relies on this. */
  email: z.string().email().max(320).optional(),
});

function getCallbackUrl(): string {
  return `${getEnv().APP_URL}/api/model-providers-oauth/callback`;
}

export function createModelProvidersOAuthRouter() {
  const router = new Hono<AppEnv>();

  // POST /api/model-providers-oauth/initiate
  // Returns { authorizationUrl, state } — frontend redirects the browser there.
  // App context required (consumes c.get("applicationId") to seed the
  // applicationProviderCredentials row); we apply requireAppContext() locally
  // because /callback can't carry X-Application-Id (browser redirect from
  // the provider — applicationId is recovered from the OAuthStateRecord).
  router.post(
    "/initiate",
    requireAppContext(),
    requirePermission("model-provider-keys", "write"),
    async (c) => {
      const orgId = c.get("orgId");
      const applicationId = c.get("applicationId");
      const user = c.get("user");
      const body = await c.req.json();
      const { providerPackageId, label } = parseBody(initiateBody, body);

      const { authorizationUrl, state } = await initiateOAuthModelProviderConnection({
        orgId,
        applicationId,
        userId: user.id,
        providerPackageId,
        label,
        redirectUri: getCallbackUrl(),
      });

      await recordAuditFromContext(c, {
        action: "oauth_model_provider.initiated",
        resourceType: "oauth_model_provider",
        resourceId: state,
        after: { providerPackageId, label },
      });

      return c.json({ authorizationUrl, state });
    },
  );

  // GET /api/model-providers-oauth/callback?code=...&state=...
  // Handles the OAuth redirect from the provider. On success, persists the
  // connection + the orgSystemProviderKeys row, then 302-redirects to the
  // settings page with the new providerKeyId.
  router.get("/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    const error = c.req.query("error");

    if (error) {
      const description = c.req.query("error_description") ?? "";
      const url = new URL(`${getEnv().APP_URL}/org-settings/models`);
      url.searchParams.set("oauthError", description || error);
      return c.redirect(url.toString(), 302);
    }
    if (!code || !state) {
      throw invalidRequest("Missing code or state in callback");
    }

    const result = await handleOAuthModelProviderCallback({ code, state });

    await recordAuditFromContext(c, {
      action: "oauth_model_provider.connected",
      resourceType: "oauth_model_provider",
      resourceId: result.providerKeyId,
      after: {
        providerPackageId: result.providerPackageId,
        connectionId: result.connectionId,
        availableModelIds: result.availableModelIds,
        // No raw token / email — audit log MUST NOT carry secrets
      },
    });

    const url = new URL(`${getEnv().APP_URL}/org-settings/models`);
    url.searchParams.set("oauthConnected", result.providerKeyId);
    url.searchParams.set("provider", result.providerPackageId);
    return c.redirect(url.toString(), 302);
  });

  // POST /api/model-providers-oauth/import
  // Called by `appstrate connect <provider>` after the CLI completed the
  // loopback OAuth dance on the user's machine. The CLI runs the dance
  // because public CLI client_ids only allowlist `http://localhost:PORT/...`
  // redirect_uris, so a platform-hosted callback is impossible.
  router.post(
    "/import",
    requireAppContext(),
    requirePermission("model-provider-keys", "write"),
    async (c) => {
      const orgId = c.get("orgId");
      const applicationId = c.get("applicationId");
      const user = c.get("user");
      const body = await c.req.json();
      const input = parseBody(importBody, body);

      const result = await importOAuthModelProviderConnection({
        orgId,
        applicationId,
        userId: user.id,
        connectionProfileId: input.connectionProfileId,
        providerPackageId: input.providerPackageId,
        label: input.label,
        accessToken: input.accessToken,
        refreshToken: input.refreshToken,
        expiresAt: input.expiresAt ?? null,
        subscriptionType: input.subscriptionType,
        email: input.email,
      });

      await recordAuditFromContext(c, {
        action: "oauth_model_provider.imported",
        resourceType: "oauth_model_provider",
        resourceId: result.providerKeyId,
        after: {
          providerPackageId: result.providerPackageId,
          connectionId: result.connectionId,
          availableModelIds: result.availableModelIds,
          // No raw token / email — audit log MUST NOT carry secrets
        },
      });

      return c.json(result);
    },
  );

  return router;
}
