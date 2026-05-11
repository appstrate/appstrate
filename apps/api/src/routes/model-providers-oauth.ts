// SPDX-License-Identifier: Apache-2.0

import { Hono, type Context, type Next } from "hono";
import { z } from "zod";
import { getEnv } from "@appstrate/env";
import type { AppEnv } from "../types/index.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import { requireAppContext } from "../middleware/app-context.ts";
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
import { forbidden, invalidRequest, notFound, parseBody } from "../lib/errors.ts";
import { recordAuditFromContext } from "../services/audit.ts";
import { getClientIp } from "../lib/client-ip.ts";

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
  // Two auth tracks land on the same route, discriminated by the auth header:
  //
  //   1. **Pairing token** (`Authorization: Bearer appp_…`) — the
  //      dashboard helper flow. The platform minted a one-shot token via
  //      /pairing; `npx @appstrate/connect-helper` POSTs the credentials
  //      back with that token as Bearer credentials. We `consumePairing()`
  //      atomically (single-use) — the resulting row's userId / orgId /
  //      providerId override anything the body claims, so a tampered
  //      helper cannot redirect the import to a different org or provider
  //      than the user authorized in the dashboard.
  //
  //   2. **Session cookie** — direct browser-initiated import. Goes
  //      through `requireAppContext` + `requirePermission` like every
  //      other dashboard write.
  //
  // The two tracks share the same body schema and the same
  // `importOAuthModelProviderConnection` call — only the auth context
  // differs. The pairing-bearer track is checked FIRST; if absent we
  // composte the legacy middleware chain inline so a single `router.post`
  // registration covers both paths.
  router.post("/import", async (c, next) => {
    const authHeader = c.req.header("authorization") ?? c.req.header("Authorization");
    if (authHeader?.startsWith("Bearer appp_")) {
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
          viaPairing: true,
          // No raw token / email — audit log MUST NOT carry secrets
        },
      });

      return c.json(result);
    }

    // No pairing-bearer — fall through to the legacy session+permission chain.
    return await sessionImportChain(c, next);
  });

  // Legacy session-auth track. Manually composes the existing middleware
  // chain so the pairing-bearer branch above can opt out without
  // registering two distinct routes.
  const sessionImportInner = async (c: Context<AppEnv>): Promise<Response> => {
    const orgId = c.get("orgId");
    const user = c.get("user");
    const body = await c.req.json();
    const input = parseBody(importBody, body);

    if (!isModelProviderEnabled(input.providerId)) {
      throw forbidden(`Provider ${input.providerId} is disabled by platform admin`);
    }

    const result = await importOAuthModelProviderConnection({
      orgId,
      userId: user.id,
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
        // No raw token / email — audit log MUST NOT carry secrets
      },
    });

    return c.json(result);
  };

  const appCtxMw = requireAppContext();
  const permMw = requirePermission("model-provider-credentials", "write");
  const sessionImportChain = async (c: Context<AppEnv>, next: Next): Promise<Response> => {
    let response: Response | undefined;
    await appCtxMw(c, async () => {
      await permMw(c, async () => {
        response = await sessionImportInner(c);
      });
    });
    if (!response) {
      // A middleware short-circuited (e.g. requireAppContext threw) — Hono
      // already handles that via its error path. Defer to next().
      await next();
      return c.res;
    }
    return response;
  };

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
    requireAppContext(),
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
  router.get(
    "/pairing/:id",
    requireAppContext(),
    requirePermission("model-provider-credentials", "read"),
    async (c) => {
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
    },
  );

  // DELETE /api/model-providers-oauth/pairing/:id
  // Cancel a pending pairing. Idempotent — returns 204 even when the row
  // is already gone (consumed, expired-and-purged, or wrong org). The
  // wrong-org case is silent for the same reason GET returns 404.
  router.delete(
    "/pairing/:id",
    requireAppContext(),
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
