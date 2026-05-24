// SPDX-License-Identifier: Apache-2.0

/**
 * AFPS integration marketplace REST surface.
 *
 * Routes (all mounted under `/api/integrations`, app-scoped):
 *
 *   - `GET    /`                                     — list available + active status
 *   - `POST   /:packageId/activate`                  — activate in current app
 *   - `DELETE /:packageId/deactivate`                — deactivate (non-destructive)
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
 * The OAuth2 callback renders a popup-close HTML page so the dashboard's
 * connect-window handler can detect completion and refresh.
 */

import { Hono } from "hono";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { applicationPackages, packages } from "@appstrate/db/schema";
import {
  handleIntegrationOAuthCallback,
  OAuthCallbackError,
  type IntegrationOAuthCallbackResult,
} from "@appstrate/connect";
import type { AppEnv } from "../types/index.ts";
import { logger } from "../lib/logger.ts";
import { ApiError, invalidRequest, internalError, notFound, parseBody } from "../lib/errors.ts";
import { listResponse } from "../lib/list-response.ts";
import { popupHtmlClose, popupHtmlError } from "../lib/oauth-popup-html.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import { getActor } from "../lib/actor.ts";
import { getAppScope } from "../lib/scope.ts";
import { recordAuditFromContext } from "./../services/audit.ts";
import { installPackage, uninstallPackage } from "../services/application-packages.ts";
import { listIntegrations } from "../services/integration-service.ts";
import {
  assertIsIntegration,
  deleteIntegrationOAuthClient,
  getIntegrationAuthStatuses,
  getIntegrationOAuthClient,
  type IntegrationOAuthClient,
  listIntegrationConnections,
  readIntegrationAuth,
  upsertIntegrationOAuthClient,
} from "../services/integration-connections.ts";
import { resolveStrategy } from "../services/connect/registry.ts";
import { createConnectRunExecutor } from "../services/connect/connect-run-launcher.ts";
import { getCurrentScopesGranted } from "../services/integration-scope-resolver.ts";
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
import { oauthStateStore } from "../services/connect/oauth-state-store.ts";

// ─────────────────────────────────────────────
// Zod schemas
// ─────────────────────────────────────────────

export const connectFieldsSchema = z.object({
  credentials: z.record(z.string(), z.string()).refine((c) => Object.keys(c).length > 0, {
    message: "credentials must contain at least one field",
  }),
});

export const connectOAuthSchema = z.object({
  scopes: z.array(z.string()).optional(),
  forceAccountSelect: z.boolean().optional(),
  connectionId: z.uuid().optional(),
});

export const updateSettingsSchema = z.object({
  blockUserConnections: z.boolean(),
});

export const setPinSchema = z.object({
  connectionId: z.uuid(),
});

export const setOrgDefaultSchema = z.object({
  connectionId: z.uuid(),
  enforce: z.boolean().default(false),
});

export const updateConnectionSchema = z
  .object({
    label: z.string().max(80).nullable().optional(),
    sharedWithOrg: z.boolean().optional(),
  })
  .refine((b) => b.label !== undefined || b.sharedWithOrg !== undefined, {
    message: "at least one of label, sharedWithOrg must be provided",
  });

export const oauthClientSchema = z.object({
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
    // Decorate with `active` + `blockUserConnections` flags for the
    // current application. An integration is "active" when an
    // application_packages row exists for it AND that install is enabled;
    // `blockUserConnections` defaults to false for inactive rows (no
    // per-app config row exists).
    const installedRows = await db
      .select({
        packageId: applicationPackages.packageId,
        enabled: applicationPackages.enabled,
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
        active: row !== undefined && row.enabled,
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

    // Persist via the OAuth2 strategy. The exchange above reconstructed the
    // actor/scope context from the signed state; the strategy does identity
    // extraction (token response + id_token + userinfo) + persist through the
    // single credential writer.
    try {
      const scope = { orgId: result.orgId, applicationId: result.applicationId };
      const { auth } = await readIntegrationAuth(scope, result.packageId, result.authKey);
      const strategy = resolveStrategy(auth);
      await strategy.complete(
        {
          scope,
          actor: result.actor,
          integrationPackageId: result.packageId,
          authKey: result.authKey,
          ...(result.connectionId ? { connectionId: result.connectionId } : {}),
        },
        { kind: "oauth2-result", result },
      );
      logger.info("Integration OAuth callback success", {
        packageId: result.packageId,
        authKey: result.authKey,
        scopeShortfall: result.scopeShortfall,
      });
    } catch (err) {
      logger.error("Integration OAuth callback persistence failed", {
        err: String(err),
      });
      // Surface the actionable identity-mismatch message verbatim (reconnect
      // authenticated a different account) instead of the generic fallback.
      if (err instanceof ApiError && err.code === "identity_mismatch") {
        return c.html(popupHtmlError(err.message));
      }
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

  // ─── Activate / deactivate ─────────────────
  //
  // "Activating" creates the application_packages row; "deactivating"
  // deletes it. Deactivation is non-destructive: connections, OAuth
  // clients, pins and org defaults FK to (package, application) — not to
  // application_packages — so they survive and are reused on reactivation
  // (mirrors how disabling a provider keeps its credentials).

  router.post(
    "/:packageId{@[^/]+/[^/]+}/activate",
    requirePermission("integrations", "install"),
    async (c) => {
      const packageId = c.req.param("packageId")!;
      const scope = getAppScope(c);
      await assertIsIntegration(scope, packageId);
      const row = await installPackage(scope, packageId);
      await recordAuditFromContext(c, {
        action: "integration.activated",
        resourceType: "integration",
        resourceId: packageId,
      });
      return c.json({ active: true, activatedAt: row.installedAt.toISOString() }, 201);
    },
  );

  router.delete(
    "/:packageId{@[^/]+/[^/]+}/deactivate",
    requirePermission("integrations", "uninstall"),
    async (c) => {
      const packageId = c.req.param("packageId")!;
      const scope = getAppScope(c);
      await assertIsIntegration(scope, packageId);
      await uninstallPackage(scope, packageId);
      await recordAuditFromContext(c, {
        action: "integration.deactivated",
        resourceType: "integration",
        resourceId: packageId,
      });
      return c.json({ active: false });
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
        const { auth } = await readIntegrationAuth(scope, packageId, authKey);
        if (auth.type === "oauth2") {
          throw invalidRequest(
            `Auth '${authKey}' is type '${auth.type}' — use the OAuth flow, not the fields flow`,
          );
        }
        // A `custom` + `connect.tool` (runAt:"link") auth resolves to the
        // OrchestratedStrategy, which needs the connect-run substrate to run
        // the untrusted login tool. Supply it lazily so the plain
        // paste-the-bag / declarative paths don't construct an executor.
        const conn = await resolveStrategy(auth, {
          connectToolExecutor: createConnectRunExecutor(),
        }).complete(
          { scope, actor, integrationPackageId: packageId, authKey },
          { kind: "fields", credentials: body.credentials },
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
      // Request exactly what the caller scopes the connect to:
      //   - manifest defaults (`auth.scopes`) — always
      //   - caller-supplied (`body.scopes`) — the agent surface forwards its
      //     inferred required scopes here when it drives an upgrade; the
      //     integration page passes none, so its "+ Add account" connects
      //     with defaults only.
      //   - already granted ON THE TARGET CONNECTION (`getCurrentScopesGranted`,
      //     keyed by `connectionId`) → reconnect/upgrade never silently shrinks
      //     what that account already authorized. Empty for a fresh connect
      //     (no row yet), so fresh connects stay at the default scope set.
      //
      // The kickoff deliberately does NOT walk installed agents anymore — that
      // would leak unrelated agents' scopes into a plain "connect" and made the
      // integration page's connect request more than its defaults. Scope
      // upgrades are an explicit, per-agent action on the agent's Connexions
      // tab. Endpoint validation + client lookup live in OAuth2Strategy.begin.
      const granted = body.connectionId
        ? await getCurrentScopesGranted({
            scope,
            integrationPackageId: packageId,
            authKey,
            actor,
            connectionId: body.connectionId,
          })
        : [];
      const scopes = [...new Set([...(auth.scopes ?? []), ...(body.scopes ?? []), ...granted])];
      const strategy = resolveStrategy(auth);
      if (!strategy.begin) {
        throw internalError();
      }
      const result = await strategy.begin(
        {
          scope,
          actor,
          integrationPackageId: packageId,
          authKey,
          ...(body.connectionId ? { connectionId: body.connectionId } : {}),
        },
        { scopes, forceAccountSelect: body.forceAccountSelect ?? false },
      );
      return c.json({ authUrl: result.redirectUrl, state: result.state });
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

/**
 * Defence-in-depth role gate paired with `requirePermission("integrations",
 * "install")` on the OAuth-client + org-default write routes. The permission
 * alone is owner/admin-only for cookie/role auth, but an API key minted by an
 * admin can carry `integrations:install` without the key itself being trusted
 * for full admin actions — this check refuses such keys on the admin-only
 * mutations regardless of the granted scope.
 */
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
