// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types/index.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import { requireAppContext } from "../middleware/app-context.ts";
import { importOAuthModelProviderConnection } from "../services/oauth-model-providers/oauth-flow.ts";
import { isOAuthModelProvider } from "../services/oauth-model-providers/registry.ts";
import { parseBody } from "../lib/errors.ts";
import { recordAuditFromContext } from "../services/audit.ts";

/**
 * Body shape posted by `appstrate connect <provider>` after the CLI has
 * completed the loopback OAuth dance against the provider's authorization
 * server. The CLI funnels the `OAuthCredentials` returned by `pi-ai` into
 * this contract; everything except `accessToken`/`refreshToken`/`label` is
 * advisory and re-derived server-side when possible.
 *
 * The browser-OAuth `/initiate` + `/callback` pair this route replaces was
 * fundamentally incompatible with the public CLI client_ids — the providers'
 * authorization servers only allowlist `http://localhost:PORT/...`
 * redirect_uris, so any platform-hosted callback URL is rejected.
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
  /**
   * Codex only — pi-ai surfaces the `chatgpt_account_id` claim as a
   * top-level `accountId` field after a successful login. We accept it
   * here so we can persist the canonical value rather than re-deriving
   * it from the JWT (which risks a base64url decode mismatch). Bounded
   * to a UUID-ish shape to keep this from being a free-form sink.
   */
  accountId: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/, "accountId must be alphanumeric/dash/underscore")
    .optional(),
});

export function createModelProvidersOAuthRouter() {
  const router = new Hono<AppEnv>();

  // POST /api/model-providers-oauth/import
  // Called by `appstrate connect <provider>` after the CLI completed the
  // loopback OAuth dance on the user's machine. The CLI runs the dance
  // because public CLI client_ids only allowlist `http://localhost:PORT/...`
  // redirect_uris, so a platform-hosted callback is impossible.
  router.post(
    "/import",
    requireAppContext(),
    requirePermission("model-provider-credentials", "write"),
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
        accountId: input.accountId,
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
