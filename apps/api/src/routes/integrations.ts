// SPDX-License-Identifier: Apache-2.0

/**
 * INTEGRATIONS_PROPOSAL Phase 1.3 — marketplace REST surface.
 *
 * Routes (all mounted under `/api/integrations`, app-scoped):
 *
 *   - `GET    /`                                     — list available + installed status
 *   - `POST   /:packageId/install`                   — install in current app
 *   - `DELETE /:packageId/install`                   — uninstall
 *   - `GET    /:packageId`                           — manifest + per-auth status for caller
 *   - `GET    /:packageId/oauth-clients/:authKey`    — admin: read registered OAuth client
 *   - `PUT    /:packageId/oauth-clients/:authKey`    — admin: register/rotate OAuth client
 *   - `DELETE /:packageId/oauth-clients/:authKey`    — admin: delete OAuth client
 *   - `POST   /:packageId/auths/:authKey/connect/oauth2`  — initiate OAuth2 PKCE flow
 *   - `POST   /:packageId/auths/:authKey/connect/fields`  — connect api_key/basic/custom
 *   - `GET    /callback`                              — OAuth2 callback handler
 *
 * Destructive connection delete moved to `DELETE /api/me/connections/:id` — the
 * single owner-scoped entry point. The agent-surface "unlink" button is gone:
 * members switch agent picks via member pins, not by deleting the shared row.
 *
 * The OAuth2 callback re-uses the same popup-close HTML as the
 * provider-side `/api/connections/callback` so the same window handler
 * works on both surfaces.
 */

import { Hono } from "hono";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { applicationPackages, packages } from "@appstrate/db/schema";
import { getEnv } from "@appstrate/env";
import { decodeJwtPayload } from "@appstrate/core/jwt";
import {
  initiateIntegrationOAuth,
  handleIntegrationOAuthCallback,
  OAuthCallbackError,
  type IntegrationOAuthCallbackResult,
} from "@appstrate/connect";
import type { AppEnv } from "../types/index.ts";
import { logger } from "../lib/logger.ts";
import {
  ApiError,
  forbidden,
  invalidRequest,
  internalError,
  notFound,
  parseBody,
} from "../lib/errors.ts";
import { listResponse } from "../lib/list-response.ts";
import { popupHtmlClose, popupHtmlError } from "../lib/oauth-popup-html.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import { getActor } from "../lib/actor.ts";
import { getAppScope } from "../lib/scope.ts";
import { recordAuditFromContext } from "./../services/audit.ts";
import { installPackage, uninstallPackage } from "../services/application-packages.ts";
import { listIntegrations, getIntegration } from "../services/integration-service.ts";
import { expandGrantedScopes } from "@appstrate/core/integration";
import {
  assertIsIntegration,
  connectIntegrationWithFields,
  deleteIntegrationOAuthClient,
  extractIdentity,
  getIntegrationAuthStatuses,
  getIntegrationOAuthClient,
  type IntegrationOAuthClient,
  listIntegrationConnections,
  readIntegrationAuth,
  saveIntegrationConnection,
  upsertIntegrationOAuthClient,
} from "../services/integration-connections.ts";
import {
  computeRequiredScopes,
  getCurrentGrantedScopes,
} from "../services/integration-scope-resolver.ts";
import { isUserConnectionCreationBlocked } from "../services/integration-connection-resolver.ts";
import {
  deleteIntegrationPin,
  listAccessibleConnections,
  listAgentsConsumingIntegration,
  listIntegrationPins,
  loadConnectionOwnership,
  resolveAgentIntegrationPick,
  setBlockUserConnections,
  updateConnectionMetadata,
  upsertIntegrationPin,
} from "../services/integration-pins-service.ts";
import {
  getOrgDefault,
  upsertOrgDefault,
  deleteOrgDefault,
} from "../services/integration-org-defaults-service.ts";
import { oauthStateStore } from "../services/connection-manager/oauth-state-store.ts";

// ─────────────────────────────────────────────
// Zod schemas
// ─────────────────────────────────────────────

const installSchema = z.object({}).optional();

const connectFieldsSchema = z.object({
  credentials: z.record(z.string(), z.string()).refine((c) => Object.keys(c).length > 0, {
    message: "credentials must contain at least one field",
  }),
});

const connectOAuthSchema = z.object({
  scopes: z.array(z.string()).optional(),
  forceAccountSelect: z.boolean().optional(),
  connectionId: z.uuid().optional(),
});

const updateSettingsSchema = z.object({
  blockUserConnections: z.boolean(),
});

const setPinSchema = z.object({
  connectionId: z.uuid(),
});

const setOrgDefaultSchema = z.object({
  connectionId: z.uuid(),
  enforce: z.boolean().default(false),
});

const updateConnectionSchema = z
  .object({
    label: z.string().max(80).nullable().optional(),
    sharedWithOrg: z.boolean().optional(),
  })
  .refine((b) => b.label !== undefined || b.sharedWithOrg !== undefined, {
    message: "at least one of label, sharedWithOrg must be provided",
  });

const oauthClientSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().default(""),
  redirectUri: z.url().optional(),
});

// ─────────────────────────────────────────────
// Guards
// ─────────────────────────────────────────────

/**
 * Refuse a connection-creation attempt when the (application, integration)
 * has `block_user_connections=true` and the caller is not an org admin.
 *
 * Workflow this enables: admin toggles the gate → connects → marks the
 * connection sharedWithOrg → members are funnelled onto the shared
 * connection via the resolver's fallback path. Members trying to bypass
 * with their own connection get a clean 403 instead of a silent override.
 *
 * Admins (`owner` / `admin`) are exempt — they can connect even when the
 * gate is on, which is the whole point (otherwise nobody could create
 * the shared connection).
 */
async function assertConnectionCreationAllowed(
  c: import("hono").Context<AppEnv>,
  applicationId: string,
  integrationPackageId: string,
): Promise<void> {
  const role = c.get("orgRole");
  if (role === "owner" || role === "admin") return;
  const blocked = await isUserConnectionCreationBlocked(applicationId, integrationPackageId);
  if (blocked) {
    throw new ApiError({
      status: 403,
      code: "connection_blocked_by_admin",
      title: "Connection Blocked by Admin",
      detail: `Creation of personal connections to '${integrationPackageId}' is disabled by the organization admin. Use the shared connection instead.`,
    });
  }
}

// ─────────────────────────────────────────────
// Router
// ─────────────────────────────────────────────

export function createIntegrationsRouter() {
  const router = new Hono<AppEnv>();

  // ─── List + detail ─────────────────────────

  router.get("/", requirePermission("integrations", "read"), async (c) => {
    const scope = getAppScope(c);
    const summaries = await listIntegrations(scope.orgId);
    // Decorate with `installed` + `blockUserConnections` flags for the
    // current application. `blockUserConnections` defaults to false for
    // not-yet-installed rows (no per-app config row exists).
    const installedRows = await db
      .select({
        packageId: applicationPackages.packageId,
        blockUserConnections: applicationPackages.blockUserConnections,
      })
      .from(applicationPackages)
      .innerJoin(packages, eq(applicationPackages.packageId, packages.id))
      .where(
        and(
          eq(applicationPackages.applicationId, scope.applicationId),
          eq(packages.type, "integration"),
        ),
      );
    const installedMap = new Map(installedRows.map((r) => [r.packageId, r]));
    const enriched = summaries.map((s) => {
      const row = installedMap.get(s.id);
      return {
        ...s,
        installed: row !== undefined,
        blockUserConnections: row?.blockUserConnections ?? false,
      };
    });
    return c.json(listResponse(enriched));
  });

  router.get("/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    const error = c.req.query("error");
    if (error) {
      logger.warn("Integration OAuth callback received error", { error });
      return c.html(popupHtmlError(`OAuth error: ${error}`, 3000));
    }
    if (!code || !state) {
      return c.html(popupHtmlError("Missing required parameters", 3000));
    }
    let result: IntegrationOAuthCallbackResult;
    try {
      result = await handleIntegrationOAuthCallback(oauthStateStore, code, state);
    } catch (err) {
      if (err instanceof OAuthCallbackError) {
        const userMessage =
          err.kind === "revoked"
            ? "The authorization expired before it could be exchanged. Please retry the connection."
            : "Could not complete the connection. Please try again in a moment.";
        logger.error("Integration OAuth callback failed", {
          providerId: err.providerId,
          kind: err.kind,
          status: err.status,
          oauthError: err.oauthError,
          oauthErrorDescription: err.oauthErrorDescription,
        });
        return c.html(popupHtmlError(userMessage));
      }
      const msg = err instanceof Error ? err.message : "OAuth callback failed";
      logger.error("Integration OAuth callback failed", { msg });
      return c.html(popupHtmlError(`Error: ${msg}`));
    }

    // Persist the connection. Identity extraction reads the manifest's
    // `extractTokenIdentity` mapping against the raw token response —
    // some IdPs return identity claims directly in the token bag (e.g.
    // Slack's `team`/`user` keys), others only in `/userinfo` (which
    // belongs in a later phase — for now we trust whatever the token
    // response surfaces).
    try {
      const scope = { orgId: result.orgId, applicationId: result.applicationId };
      const manifest = (await getIntegration(scope.orgId, result.packageId))?.manifest;
      if (!manifest) {
        logger.error("Integration vanished between initiate and callback", {
          packageId: result.packageId,
        });
        return c.html(popupHtmlError("Integration not found"));
      }
      // Build the identity source for `extractIdentity`. Three layers,
      // applied in order so later layers don't overwrite earlier ones:
      //   1. Token response top-level (some IdPs put identity there).
      //   2. `id_token` JWT claims — OIDC providers (Google, Microsoft,
      //      Okta, …). No sig check: PKCE + signed state already vetted
      //      the channel, we use the claims for identity hints only.
      //   3. `userinfoUrl` GET — non-OIDC OAuth2 (GitHub, Slack, Notion,
      //      …) returns identity from a Bearer-protected endpoint. Without
      //      this fetch, `accountId` would fall back to the literal
      //      "default" and every new connection collapses onto the same
      //      row (the bug that made "Add another connection" silently
      //      overwrite the existing one).
      const identitySource: Record<string, unknown> = { ...result.tokenResponse };
      const idToken = result.tokenResponse.id_token;
      if (typeof idToken === "string") {
        const claims = decodeJwtPayload(idToken);
        if (claims) {
          for (const [k, v] of Object.entries(claims)) {
            if (identitySource[k] === undefined) identitySource[k] = v;
          }
        }
      }
      const authDecl = manifest.auths?.[result.authKey];
      const userinfoUrl = authDecl?.userinfoUrl;
      if (userinfoUrl) {
        try {
          const res = await fetch(userinfoUrl, {
            headers: {
              Authorization: `Bearer ${result.accessToken}`,
              Accept: "application/json",
              "User-Agent": "Appstrate",
            },
          });
          if (res.ok) {
            const body = (await res.json()) as unknown;
            if (body && typeof body === "object") {
              for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
                if (identitySource[k] === undefined) identitySource[k] = v;
              }
            }
          } else {
            logger.warn("Integration userinfo fetch non-2xx", {
              packageId: result.packageId,
              authKey: result.authKey,
              status: res.status,
            });
          }
        } catch (err) {
          logger.warn("Integration userinfo fetch failed", {
            packageId: result.packageId,
            authKey: result.authKey,
            err: String(err),
          });
        }
      }
      const { accountId, identityClaims } = extractIdentity(
        manifest,
        result.authKey,
        identitySource,
      );
      const credentials: Record<string, unknown> = {
        access_token: result.accessToken,
        ...(result.refreshToken ? { refresh_token: result.refreshToken } : {}),
        ...(result.tokenResponse.token_type
          ? { token_type: String(result.tokenResponse.token_type) }
          : {}),
        ...(result.tokenResponse.id_token
          ? { id_token: String(result.tokenResponse.id_token) }
          : {}),
        scope: result.scopesGranted.join(" "),
      };
      await saveIntegrationConnection(scope, {
        packageId: result.packageId,
        authKey: result.authKey,
        accountId,
        credentials,
        identityClaims,
        scopesGranted: result.scopesGranted,
        expiresAt: result.expiresAt ? new Date(result.expiresAt) : null,
        actor: result.actor,
        ...(result.connectionId ? { connectionId: result.connectionId } : {}),
      });
      logger.info("Integration OAuth callback success", {
        packageId: result.packageId,
        authKey: result.authKey,
        accountId,
        scopeShortfall: result.scopeShortfall,
      });
    } catch (err) {
      logger.error("Integration OAuth callback persistence failed", {
        err: String(err),
      });
      return c.html(popupHtmlError("Could not save the connection."));
    }
    return c.html(popupHtmlClose());
  });

  router.get("/:packageId{@[^/]+/[^/]+}", requirePermission("integrations", "read"), async (c) => {
    const packageId = c.req.param("packageId")!;
    const scope = getAppScope(c);
    const actor = getActor(c);
    await assertIsIntegration(scope, packageId);
    const status = await getIntegrationAuthStatuses(scope, packageId, actor);
    return c.json(status);
  });

  // ─── Install / uninstall ───────────────────

  router.post(
    "/:packageId{@[^/]+/[^/]+}/install",
    requirePermission("integrations", "install"),
    async (c) => {
      const packageId = c.req.param("packageId")!;
      const scope = getAppScope(c);
      await assertIsIntegration(scope, packageId);
      const body = await c.req.json().catch(() => ({}));
      installSchema.parse(body);
      const row = await installPackage(scope, packageId);
      await recordAuditFromContext(c, {
        action: "integration.installed",
        resourceType: "integration",
        resourceId: packageId,
      });
      return c.json({ installed: true, installedAt: row.installedAt.toISOString() }, 201);
    },
  );

  router.delete(
    "/:packageId{@[^/]+/[^/]+}/install",
    requirePermission("integrations", "uninstall"),
    async (c) => {
      const packageId = c.req.param("packageId")!;
      const scope = getAppScope(c);
      await assertIsIntegration(scope, packageId);
      await uninstallPackage(scope, packageId);
      await recordAuditFromContext(c, {
        action: "integration.uninstalled",
        resourceType: "integration",
        resourceId: packageId,
      });
      return c.json({ uninstalled: true });
    },
  );

  // ─── OAuth client registration (admin) ─────

  router.get(
    "/:packageId{@[^/]+/[^/]+}/oauth-clients/:authKey",
    requirePermission("integrations", "read"),
    async (c) => {
      const packageId = c.req.param("packageId")!;
      const authKey = c.req.param("authKey")!;
      const scope = getAppScope(c);
      const client = await getIntegrationOAuthClient(scope, packageId, authKey);
      if (!client)
        throw notFound(`No OAuth client registered for '${packageId}' auth '${authKey}'`);
      const { clientSecret: _clientSecret, ...publicShape } = client;
      return c.json(publicShape satisfies IntegrationOAuthClient);
    },
  );

  // Phase 2 (niveau 2 scope model) — surface the scope union the OAuth
  // kickoff is going to request. UI uses this to show "this integration
  // will request: X, Y, Z" before the user clicks Connect, and to detect
  // the "agent install needs an upgrade" case (required ⊄ granted).
  router.get(
    "/:packageId{@[^/]+/[^/]+}/auths/:authKey/required-scopes",
    requirePermission("integrations", "read"),
    async (c) => {
      const packageId = c.req.param("packageId")!;
      const authKey = c.req.param("authKey")!;
      const scope = getAppScope(c);
      const actor = getActor(c);
      const { manifest, auth } = await readIntegrationAuth(scope, packageId, authKey);
      const [computed, granted] = await Promise.all([
        computeRequiredScopes({ scope, integrationPackageId: packageId, authKey }),
        getCurrentGrantedScopes({
          scope,
          integrationPackageId: packageId,
          authKey,
          actor,
        }),
      ]);
      const defaults = auth.scopes ?? [];
      const union = [...new Set([...defaults, ...computed.required, ...granted])];
      const effective = new Set(expandGrantedScopes(granted, manifest, authKey));
      const missingFromGranted = union.filter((s) => !effective.has(s));
      return c.json({
        defaults,
        required: computed.required,
        granted,
        union,
        missingFromGranted,
        breakdown: computed.breakdown,
      });
    },
  );

  router.put(
    "/:packageId{@[^/]+/[^/]+}/oauth-clients/:authKey",
    requirePermission("integrations", "install"),
    async (c) => {
      const packageId = c.req.param("packageId")!;
      const authKey = c.req.param("authKey")!;
      const scope = getAppScope(c);
      const body = parseBody(oauthClientSchema, await c.req.json());
      const client = await upsertIntegrationOAuthClient(scope, packageId, authKey, body);
      await recordAuditFromContext(c, {
        action: "integration.oauth_client.upserted",
        resourceType: "integration",
        resourceId: `${packageId}#${authKey}`,
      });
      return c.json(client);
    },
  );

  router.delete(
    "/:packageId{@[^/]+/[^/]+}/oauth-clients/:authKey",
    requirePermission("integrations", "install"),
    async (c) => {
      const packageId = c.req.param("packageId")!;
      const authKey = c.req.param("authKey")!;
      const scope = getAppScope(c);
      await deleteIntegrationOAuthClient(scope, packageId, authKey);
      await recordAuditFromContext(c, {
        action: "integration.oauth_client.deleted",
        resourceType: "integration",
        resourceId: `${packageId}#${authKey}`,
      });
      return c.json({ deleted: true });
    },
  );

  // ─── Connect flows ─────────────────────────

  router.post(
    "/:packageId{@[^/]+/[^/]+}/auths/:authKey/connect/fields",
    requirePermission("integrations", "connect"),
    async (c) => {
      const packageId = c.req.param("packageId")!;
      const authKey = c.req.param("authKey")!;
      const scope = getAppScope(c);
      const actor = getActor(c);
      await assertConnectionCreationAllowed(c, scope.applicationId, packageId);
      const body = parseBody(connectFieldsSchema, await c.req.json());
      try {
        const conn = await connectIntegrationWithFields(
          scope,
          packageId,
          authKey,
          body.credentials,
          actor,
        );
        await recordAuditFromContext(c, {
          action: "integration.connection.created",
          resourceType: "integration_connection",
          resourceId: conn.id,
          after: { packageId, authKey, accountId: conn.accountId },
        });
        return c.json(conn);
      } catch (err) {
        if (err instanceof ApiError) throw err;
        logger.error("Integration fields connect failed", { err: String(err) });
        throw internalError();
      }
    },
  );

  router.post(
    "/:packageId{@[^/]+/[^/]+}/auths/:authKey/connect/oauth2",
    requirePermission("integrations", "connect"),
    async (c) => {
      const packageId = c.req.param("packageId")!;
      const authKey = c.req.param("authKey")!;
      const scope = getAppScope(c);
      const actor = getActor(c);
      await assertConnectionCreationAllowed(c, scope.applicationId, packageId);
      const body = parseBody(connectOAuthSchema, await c.req.json().catch(() => ({})));

      const { auth } = await readIntegrationAuth(scope, packageId, authKey);
      if (auth.type !== "oauth2") {
        throw invalidRequest(
          `Auth '${authKey}' is type '${auth.type}' — use the fields flow instead`,
        );
      }
      if (!auth.authorizationUrl || !auth.tokenUrl) {
        // Mode B (discovery) is implemented in `@appstrate/connect/oauth-discovery`
        // but the user-facing flow needs resolved endpoints up front so the popup
        // can navigate immediately. Delegate that resolution to the runtime spawn
        // path for now; surface a clear error here.
        throw invalidRequest(
          "OAuth Mode B (RFC 9728 discovery) connection flow not yet wired — manifest must declare explicit authorizationUrl + tokenUrl for marketplace connect.",
        );
      }
      const client = await getIntegrationOAuthClient(scope, packageId, authKey);
      if (!client) {
        throw forbidden(
          `Administrator must register OAuth client credentials for '${packageId}' auth '${authKey}' before connection`,
        );
      }
      const redirectUri = client.redirectUri ?? `${getEnv().APP_URL}/api/integrations/callback`;
      // Niveau 2 (Phase 2) — request the strict superset of:
      //   - manifest defaults (`auth.scopes`)
      //   - caller-supplied (`body.scopes`)
      //   - inferred from agents installed in this app (`computeRequiredScopes`)
      //   - currently granted across the actor's existing connections
      //     (`getCurrentGrantedScopes`) → incremental consent
      // Granted is unioned so re-consent never silently shrinks the set
      // the user already authorized.
      const [computed, granted] = await Promise.all([
        computeRequiredScopes({
          scope,
          integrationPackageId: packageId,
          authKey,
        }),
        getCurrentGrantedScopes({
          scope,
          integrationPackageId: packageId,
          authKey,
          actor,
        }),
      ]);
      const scopes = [
        ...new Set([
          ...(auth.scopes ?? []),
          ...(body.scopes ?? []),
          ...computed.required,
          ...granted,
        ]),
      ];
      const result = await initiateIntegrationOAuth(oauthStateStore, {
        packageId,
        authKey,
        authorizationUrl: auth.authorizationUrl,
        tokenUrl: auth.tokenUrl,
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        tokenAuthMethod: auth.tokenAuthMethod,
        scopes,
        scopeSeparator: auth.scopeSeparator,
        audience: auth.audience,
        redirectUri,
        orgId: scope.orgId,
        applicationId: scope.applicationId,
        actor,
        // Integration connections aren't keyed by connection_profiles
        // (that model is provider-side only) — we still carry an ID
        // through for the state record shape. Use a fixed sentinel so
        // the field is non-empty.
        connectionProfileId: "integration",
        forceAccountSelect: body.forceAccountSelect ?? false,
        ...(body.connectionId ? { connectionId: body.connectionId } : {}),
      });
      return c.json({ authUrl: result.authUrl, state: result.state });
    },
  );

  // DELETE /:packageId/connections/:connectionId was removed — destructive
  // delete is now owner-scoped via `DELETE /api/me/connections/:connectionId`
  // (single entry point on /connections, surfaces a confirm dialog with the
  // impact list). The agent surface used to call this endpoint as part of
  // an "unlink" button that conflated "stop this agent from using this
  // connection" with "delete the connection globally" — the bug that drove
  // the integration refactor. Members now switch the agent's pick via the
  // member-pin endpoint (`PUT /api/me/integration-pins`).

  router.get(
    "/:packageId{@[^/]+/[^/]+}/connections",
    requirePermission("integrations", "read"),
    async (c) => {
      const packageId = c.req.param("packageId")!;
      const scope = getAppScope(c);
      const actor = getActor(c);
      const items = await listIntegrationConnections(scope, packageId, actor);
      return c.json(listResponse(items));
    },
  );

  /**
   * GET /api/integrations/:packageId/accessible-connections
   *
   * Lists every connection the actor could pick for this integration at
   * run-kickoff: own + shared-with-org. Drives the pre-run picker on
   * agent surfaces (R3) so a member sees the ambiguity and resolves it
   * upfront instead of via the 412 recovery modal.
   */
  router.get(
    "/:packageId{@[^/]+/[^/]+}/accessible-connections",
    requirePermission("integrations", "read"),
    async (c) => {
      const packageId = c.req.param("packageId")!;
      const scope = getAppScope(c);
      const actor = getActor(c);
      const actorFilter = actor.type === "user" ? { userId: actor.id } : { endUserId: actor.id };
      const items = await listAccessibleConnections(scope, packageId, actorFilter);
      return c.json(listResponse(items));
    },
  );

  /**
   * GET /api/integrations/:packageId/agent-resolution/:agentPackageId
   *
   * Single-source verdict for the agent-page connection picker: which
   * connection the next run would use (admin pin → overrides → member pin →
   * fallback + scope check), plus the annotated candidate list and pin /
   * blocked state. The picker renders this verbatim instead of
   * re-implementing the resolver cascade client-side.
   */
  router.get(
    "/:packageId{@[^/]+/[^/]+}/agent-resolution/:agentPackageId{@[^/]+/[^/]+}",
    requirePermission("integrations", "read"),
    async (c) => {
      const packageId = c.req.param("packageId")!;
      const agentPackageId = c.req.param("agentPackageId")!;
      const scope = getAppScope(c);
      const actor = getActor(c);
      const role = c.get("orgRole");
      const result = await resolveAgentIntegrationPick({
        scope,
        agentPackageId,
        integrationPackageId: packageId,
        actor,
        isAdmin: role === "owner" || role === "admin",
      });
      return c.json(result);
    },
  );

  // ─── Admin: block_user_connections + pins + connection metadata ──

  router.patch(
    "/:packageId{@[^/]+/[^/]+}/settings",
    requirePermission("integrations", "install"),
    async (c) => {
      assertOrgAdmin(c);
      const packageId = c.req.param("packageId")!;
      const scope = getAppScope(c);
      await assertIsIntegration(scope, packageId);
      const body = parseBody(updateSettingsSchema, await c.req.json());
      const result = await setBlockUserConnections(scope, packageId, body.blockUserConnections);
      await recordAuditFromContext(c, {
        action: "integration.block_user_connections.updated",
        resourceType: "integration",
        resourceId: packageId,
        after: { blocked: result.blocked },
      });
      return c.json(result);
    },
  );

  router.get(
    "/:packageId{@[^/]+/[^/]+}/pins",
    requirePermission("integrations", "read"),
    async (c) => {
      const packageId = c.req.param("packageId")!;
      const scope = getAppScope(c);
      const items = await listIntegrationPins(scope, packageId);
      return c.json(listResponse(items));
    },
  );

  /**
   * R2 — installed agents in the application that declare this integration
   * in their dependencies. Drives the "pin a new agent" picker on the
   * integration detail page so admins can manage pins from one place.
   */
  router.get(
    "/:packageId{@[^/]+/[^/]+}/consuming-agents",
    requirePermission("integrations", "read"),
    async (c) => {
      const packageId = c.req.param("packageId")!;
      const scope = getAppScope(c);
      const items = await listAgentsConsumingIntegration(scope, packageId);
      return c.json(listResponse(items));
    },
  );

  router.put(
    "/:packageId{@[^/]+/[^/]+}/pins/:agentPackageId{@[^/]+/[^/]+}",
    requirePermission("integrations", "install"),
    async (c) => {
      assertOrgAdmin(c);
      const packageId = c.req.param("packageId")!;
      const agentPackageId = c.req.param("agentPackageId")!;
      const scope = getAppScope(c);
      const body = parseBody(setPinSchema, await c.req.json());
      const userId = c.get("user")?.id ?? null;
      const pin = await upsertIntegrationPin(scope, packageId, {
        agentPackageId,
        connectionId: body.connectionId,
        createdBy: userId,
      });
      await recordAuditFromContext(c, {
        action: "integration.pin.upserted",
        resourceType: "integration_pin",
        resourceId: `${packageId}#${agentPackageId}`,
        after: { connectionId: pin.connectionId },
      });
      return c.json(pin);
    },
  );

  router.delete(
    "/:packageId{@[^/]+/[^/]+}/pins/:agentPackageId{@[^/]+/[^/]+}",
    requirePermission("integrations", "install"),
    async (c) => {
      assertOrgAdmin(c);
      const packageId = c.req.param("packageId")!;
      const agentPackageId = c.req.param("agentPackageId")!;
      const scope = getAppScope(c);
      const result = await deleteIntegrationPin(scope, packageId, agentPackageId);
      if (result.deleted) {
        await recordAuditFromContext(c, {
          action: "integration.pin.deleted",
          resourceType: "integration_pin",
          resourceId: `${packageId}#${agentPackageId}`,
        });
      }
      return c.json(result);
    },
  );

  // ─── Org default connection (cross-agent governance) ─────────────────────
  // One default connection per (application, integration) — the resolver
  // baseline for every consuming agent (enforce → org-wide lock; soft →
  // overridable by member pins). Admin-only.

  router.get(
    "/:packageId{@[^/]+/[^/]+}/default",
    requirePermission("integrations", "read"),
    async (c) => {
      const packageId = c.req.param("packageId")!;
      const scope = getAppScope(c);
      const item = await getOrgDefault(scope, packageId);
      return c.json({ default: item });
    },
  );

  router.put(
    "/:packageId{@[^/]+/[^/]+}/default",
    requirePermission("integrations", "install"),
    async (c) => {
      assertOrgAdmin(c);
      const packageId = c.req.param("packageId")!;
      const scope = getAppScope(c);
      const body = parseBody(setOrgDefaultSchema, await c.req.json());
      const userId = c.get("user")?.id ?? null;
      const def = await upsertOrgDefault(scope, packageId, {
        connectionId: body.connectionId,
        enforce: body.enforce,
        createdBy: userId,
      });
      await recordAuditFromContext(c, {
        action: "integration.org_default.upserted",
        resourceType: "integration_org_default",
        resourceId: packageId,
        after: { connectionId: def.connectionId, enforce: def.enforce },
      });
      return c.json(def);
    },
  );

  router.delete(
    "/:packageId{@[^/]+/[^/]+}/default",
    requirePermission("integrations", "install"),
    async (c) => {
      assertOrgAdmin(c);
      const packageId = c.req.param("packageId")!;
      const scope = getAppScope(c);
      const result = await deleteOrgDefault(scope, packageId);
      if (result.deleted) {
        await recordAuditFromContext(c, {
          action: "integration.org_default.deleted",
          resourceType: "integration_org_default",
          resourceId: packageId,
        });
      }
      return c.json(result);
    },
  );

  router.patch(
    "/:packageId{@[^/]+/[^/]+}/connections/:connectionId",
    requirePermission("integrations", "connect"),
    async (c) => {
      const connectionId = c.req.param("connectionId")!;
      const scope = getAppScope(c);
      const actor = getActor(c);
      const ownership = await loadConnectionOwnership(connectionId);
      if (!ownership || ownership.applicationId !== scope.applicationId) {
        throw notFound(`Connection '${connectionId}' not found`);
      }
      // Owner OR org admin can edit metadata. Sharing the connection
      // is consent: only the owner should toggle sharedWithOrg, so we
      // refuse non-owner edits to that field specifically.
      const isOwner =
        (actor.type === "user" && ownership.userId === actor.id) ||
        (actor.type === "end_user" && ownership.endUserId === actor.id);
      const role = c.get("orgRole");
      const isAdmin = role === "owner" || role === "admin";
      if (!isOwner && !isAdmin) {
        throw new ApiError({
          status: 403,
          code: "forbidden",
          title: "Forbidden",
          detail: "Only the connection owner or an org admin can update this connection",
        });
      }
      const body = parseBody(updateConnectionSchema, await c.req.json());
      if (body.sharedWithOrg !== undefined && !isOwner) {
        throw new ApiError({
          status: 403,
          code: "forbidden",
          title: "Forbidden",
          detail: "Only the connection owner can change sharedWithOrg",
        });
      }
      const updated = await updateConnectionMetadata(connectionId, body);
      await recordAuditFromContext(c, {
        action: "integration.connection.metadata.updated",
        resourceType: "integration_connection",
        resourceId: connectionId,
        after: {
          ...(body.label !== undefined ? { label: body.label } : {}),
          ...(body.sharedWithOrg !== undefined ? { sharedWithOrg: body.sharedWithOrg } : {}),
        },
      });
      return c.json({
        id: updated.id,
        label: updated.label,
        sharedWithOrg: updated.sharedWithOrg,
        updatedAt: updated.updatedAt.toISOString(),
      });
    },
  );

  return router;
}

function assertOrgAdmin(c: import("hono").Context<AppEnv>): void {
  const role = c.get("orgRole");
  if (role !== "owner" && role !== "admin") {
    throw new ApiError({
      status: 403,
      code: "forbidden",
      title: "Forbidden",
      detail: "Org admin or owner role required",
    });
  }
}
