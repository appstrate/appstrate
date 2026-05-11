// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { z } from "zod";
import { getEnv } from "@appstrate/env";
import type { AppEnv } from "../types/index.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import { rateLimit } from "../middleware/rate-limit.ts";
import { importOAuthModelProviderConnection } from "../services/oauth-model-providers/oauth-flow.ts";
import {
  isModelProviderEnabled,
  isOAuthModelProvider,
} from "../services/oauth-model-providers/registry.ts";
import {
  cancelPairing,
  consumePairing,
  createPairing,
  getPairing,
} from "../services/oauth-model-providers/pairings.ts";
import { forbidden, invalidRequest, notFound, parseBody, unauthorized } from "../lib/errors.ts";
import { recordAuditFromContext } from "../services/audit.ts";
import { getClientIp } from "../lib/client-ip.ts";

/**
 * Body shape posted by `npx @appstrate/connect-helper <token>` after it
 * completes the loopback OAuth dance against the provider's authorization
 * server. The helper funnels the `OAuthCredentials` returned by `pi-ai`
 * into this contract; everything except `accessToken`/`refreshToken`/`label`
 * is advisory and re-derived server-side when possible.
 *
 * The browser-OAuth `/initiate` + `/callback` pair this route replaces was
 * fundamentally incompatible with the public CLI client_ids — the providers'
 * authorization servers only allowlist `http://localhost:PORT/...`
 * redirect_uris, so any platform-hosted callback URL is rejected.
 */
const importBody = z.object({
  providerId: z
    .string()
    .min(1)
    .refine(
      (id) => isOAuthModelProvider(id),
      "providerId must be a registered OAuth model provider",
    ),
  label: z.string().min(1, "label is required").max(120),
  accessToken: z.string().min(1, "accessToken is required"),
  refreshToken: z.string().min(1, "refreshToken is required"),
  /** Unix ms timestamp; CLI converts pi-ai's `expires` field as-is. */
  expiresAt: z.number().int().positive().optional().nullable(),
  /** Claude-only: subscription tier from the token response body. */
  subscriptionType: z.string().max(40).optional(),
  /** Account email; Codex re-derives from JWT, Claude relies on this. */
  email: z.email().max(320).optional(),
  /**
   * Codex only — pi-ai surfaces the `chatgpt_account_id` claim as a
   * top-level `accountId` field after a successful login. We accept it
   * here so we can persist the canonical value rather than re-deriving
   * it from the JWT (which risks a base64url decode mismatch). Constrained
   * to a strict UUID — Codex's `chatgpt_account_id` is canonically a UUID,
   * so anything else is a malformed payload and rejecting it early keeps
   * downstream header injection (`chatgpt-account-id`) honest.
   */
  accountId: z.uuid().optional(),
});

export function createModelProvidersOAuthRouter() {
  const router = new Hono<AppEnv>();

  // POST /api/model-providers-oauth/import
  //
  // Auth is exclusively `Authorization: Bearer appp_<token>`. The platform
  // minted the token via POST /pairing (session-auth + RBAC); the helper
  // POSTs the credentials back here with it as Bearer credentials. We
  // `consumePairing()` atomically (single-use) — the resulting row's
  // userId / orgId / providerId override anything the body claims, so a
  // tampered helper cannot redirect the import to a different org or
  // provider than the user authorized in the dashboard.
  //
  // No cookie / API-key path: the dashboard never POSTs to this route,
  // it only mints pairings + polls their status. `auth-pipeline.ts` lets
  // requests with `Bearer appp_` skip the cookie/API-key chain; any other
  // shape lands here and we 401.
  router.post("/import", async (c) => {
    const authHeader = c.req.header("authorization") ?? c.req.header("Authorization");
    if (!authHeader?.startsWith("Bearer appp_")) {
      throw unauthorized(
        "POST /api/model-providers-oauth/import requires a pairing-token bearer (Authorization: Bearer appp_…)",
      );
    }

    const token = authHeader.slice(7);
    const fromIp = getClientIp(c);
    const consumed = await consumePairing(token, fromIp === "unknown" ? undefined : fromIp);

    const body = await c.req.json();
    const input = parseBody(importBody, body);

    // Body's providerId MUST match what the pairing was minted for —
    // otherwise the helper could divert the import to a different
    // provider than the user authorized in the dashboard.
    if (input.providerId !== consumed.providerId) {
      throw invalidRequest(
        `providerId in body (${input.providerId}) does not match pairing (${consumed.providerId})`,
        "providerId",
      );
    }
    if (!isModelProviderEnabled(input.providerId)) {
      throw forbidden(`Provider ${input.providerId} is disabled by platform admin`);
    }

    const result = await importOAuthModelProviderConnection({
      orgId: consumed.orgId,
      userId: consumed.userId,
      providerId: input.providerId,
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
      resourceId: result.credentialId,
      after: {
        providerId: result.providerId,
        credentialId: result.credentialId,
        availableModelIds: result.availableModelIds,
        pairingId: consumed.id,
        // No raw token / email — audit log MUST NOT carry secrets
      },
    });

    return c.json(result);
  });

  // ────────────────────────────────────────────────────────────────────────
  // Pairing flow (dashboard-initiated OAuth model provider connection)
  //
  // The browser POSTs /pairing → token + `npx` command surfaced in the UI
  // → user pastes into terminal → `@appstrate/connect-helper` runs the
  // loopback OAuth dance → POSTs credentials to /import using the pairing
  // token as Bearer credentials. The Bearer-auth path on /import is wired
  // in a separate change; this router only exposes the lifecycle CRUD.
  // ────────────────────────────────────────────────────────────────────────

  /** Pairing token TTL — 5 minutes is enough for the user to switch tabs and paste. */
  const PAIRING_TTL_SECONDS = 300;

  /** providerId regex matches the registry's canonical ids. */
  const providerIdSchema = z
    .string()
    .regex(/^[a-z0-9-]+$/, "providerId must be lowercase kebab-case");

  const createPairingBody = z.object({
    providerId: providerIdSchema.refine(
      (id) => isOAuthModelProvider(id),
      "providerId must be a registered OAuth model provider",
    ),
  });

  const pairingIdParam = z.object({
    id: z.string().regex(/^pair_[A-Za-z0-9_-]+$/, "id must look like pair_<base64url>"),
  });

  // POST /api/model-providers-oauth/pairing
  // Mint a one-shot pairing token. Returns the plaintext token + a
  // ready-to-paste `npx` command. The token is shown once; subsequent
  // GETs only ever return status, never the token itself.
  router.post(
    "/pairing",
    requirePermission("model-provider-credentials", "write"),
    rateLimit(10),
    async (c) => {
      const orgId = c.get("orgId");
      const user = c.get("user");
      const body = await c.req.json().catch(() => ({}));
      const input = parseBody(createPairingBody, body);

      // Same soft-disable gate as /import — disabled providers cannot have
      // new pairings minted, but existing credentials keep working.
      if (!isModelProviderEnabled(input.providerId)) {
        throw forbidden(`Provider ${input.providerId} is disabled by platform admin`);
      }

      const platformUrl = getEnv().APP_URL;
      const { id, token, expiresAt } = await createPairing({
        userId: user.id,
        orgId,
        providerId: input.providerId,
        platformUrl,
        ttlSeconds: PAIRING_TTL_SECONDS,
      });

      const command = `npx @appstrate/connect-helper@latest ${token}`;

      await recordAuditFromContext(c, {
        action: "oauth_model_provider.pairing_created",
        resourceType: "oauth_model_provider_pairing",
        resourceId: id,
        after: {
          providerId: input.providerId,
          expiresAt: expiresAt.toISOString(),
          // No raw token in audit — leaks the bearer secret otherwise.
        },
      });

      return c.json({
        id,
        token,
        command,
        expiresAt: expiresAt.toISOString(),
      });
    },
  );

  // GET /api/model-providers-oauth/pairing/:id
  // Polled by the dashboard while the user runs the helper. Returns
  // `pending` until the helper consumes the token, `consumed` after,
  // `expired` once the TTL elapsed without consumption.
  //
  // Wrong-org reads return 404 (not 403) — we never confirm or deny
  // existence of a pairing belonging to a different tenant.
  router.get("/pairing/:id", requirePermission("model-provider-credentials", "read"), async (c) => {
    const orgId = c.get("orgId");
    const { id } = parseBody(pairingIdParam, { id: c.req.param("id") }, "id");

    const row = await getPairing(id, orgId);
    if (!row) throw notFound("Pairing not found");

    const now = Date.now();
    let status: "pending" | "consumed" | "expired";
    if (row.consumedAt) status = "consumed";
    else if (row.expiresAt.getTime() <= now) status = "expired";
    else status = "pending";

    return c.json({
      id: row.id,
      status,
      consumedAt: row.consumedAt ? row.consumedAt.toISOString() : null,
      expiresAt: row.expiresAt.toISOString(),
    });
  });

  // DELETE /api/model-providers-oauth/pairing/:id
  // Cancel a pending pairing. Idempotent — returns 204 even when the row
  // is already gone (consumed, expired-and-purged, or wrong org). The
  // wrong-org case is silent for the same reason GET returns 404.
  router.delete(
    "/pairing/:id",
    requirePermission("model-provider-credentials", "write"),
    async (c) => {
      const orgId = c.get("orgId");
      const { id } = parseBody(pairingIdParam, { id: c.req.param("id") }, "id");

      await cancelPairing(id, orgId);

      await recordAuditFromContext(c, {
        action: "oauth_model_provider.pairing_cancelled",
        resourceType: "oauth_model_provider_pairing",
        resourceId: id,
      });

      return c.body(null, 204);
    },
  );

  return router;
}
