// SPDX-License-Identifier: Apache-2.0

/**
 * INTEGRATIONS_PROPOSAL Phase 1.3 — marketplace REST surface.
 *
 * Routes (all mounted under `/api/integrations`, app-scoped):
 *
 *   - `GET    /`                                     — list available + installed status
 *   - `GET    /installed`                            — list installed in current app
 *   - `POST   /:packageId/install`                   — install in current app
 *   - `DELETE /:packageId/install`                   — uninstall
 *   - `GET    /:packageId`                           — manifest + per-auth status for caller
 *   - `GET    /:packageId/oauth-clients/:authKey`    — admin: read registered OAuth client
 *   - `PUT    /:packageId/oauth-clients/:authKey`    — admin: register/rotate OAuth client
 *   - `DELETE /:packageId/oauth-clients/:authKey`    — admin: delete OAuth client
 *   - `POST   /:packageId/auths/:authKey/connect/oauth2`  — initiate OAuth2 PKCE flow
 *   - `POST   /:packageId/auths/:authKey/connect/fields`  — connect api_key/basic/custom
 *   - `DELETE /:packageId/connections/:connectionId`      — disconnect single connection
 *   - `GET    /callback`                              — OAuth2 callback handler
 *
 * The OAuth2 callback re-uses the legacy `/api/connections/callback`
 * popup-close HTML so the same window handler works on both surfaces.
 */

import { Hono } from "hono";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { applicationPackages, packages } from "@appstrate/db/schema";
import { escapeHtml } from "@appstrate/core/html";
import { getEnv } from "@appstrate/env";
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
import { requirePermission } from "../middleware/require-permission.ts";
import { getActor } from "../lib/actor.ts";
import { getAppScope } from "../lib/scope.ts";
import { recordAuditFromContext } from "./../services/audit.ts";
import { installPackage, uninstallPackage } from "../services/application-packages.ts";
import { listIntegrations, getIntegration } from "../services/integration-service.ts";
import {
  assertIsIntegration,
  connectIntegrationWithFields,
  deleteIntegrationConnection,
  deleteIntegrationOAuthClient,
  extractIdentity,
  getIntegrationAuthStatuses,
  getIntegrationOAuthClient,
  listIntegrationConnections,
  loadIntegrationOAuthClientForFlow,
  readIntegrationAuth,
  saveIntegrationConnection,
  upsertIntegrationOAuthClient,
} from "../services/integration-connections.ts";
import { oauthStateStore } from "../services/connection-manager/oauth-state-store.ts";

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function getOAuthCallbackUrl(): string {
  return `${getEnv().APP_URL}/api/integrations/callback`;
}

function popupHtmlClose(): string {
  return `<html><body><script>window.close();</script></body></html>`;
}

function popupHtmlError(msg: string, ttlMs = 5000): string {
  return `<html><body><p style="color:red;font-family:monospace;">${escapeHtml(msg)}</p><script>setTimeout(()=>window.close(),${ttlMs});</script></body></html>`;
}

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
});

const oauthClientSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().default(""),
  redirectUri: z.url().optional(),
});

// ─────────────────────────────────────────────
// Router
// ─────────────────────────────────────────────

export function createIntegrationsRouter() {
  const router = new Hono<AppEnv>();

  // ─── List + detail ─────────────────────────

  router.get("/", requirePermission("integrations", "read"), async (c) => {
    const scope = getAppScope(c);
    const summaries = await listIntegrations(scope.orgId);
    // Decorate with `installed` flag for the current application.
    const installedRows = await db
      .select({ packageId: applicationPackages.packageId })
      .from(applicationPackages)
      .innerJoin(packages, eq(applicationPackages.packageId, packages.id))
      .where(
        and(
          eq(applicationPackages.applicationId, scope.applicationId),
          eq(packages.type, "integration"),
        ),
      );
    const installedSet = new Set(installedRows.map((r) => r.packageId));
    const enriched = summaries.map((s) => ({
      ...s,
      installed: installedSet.has(s.id),
    }));
    return c.json(listResponse(enriched));
  });

  router.get("/installed", requirePermission("integrations", "read"), async (c) => {
    const scope = getAppScope(c);
    const installedRows = await db
      .select({
        packageId: applicationPackages.packageId,
        installedAt: applicationPackages.installedAt,
        enabled: applicationPackages.enabled,
      })
      .from(applicationPackages)
      .innerJoin(packages, eq(applicationPackages.packageId, packages.id))
      .where(
        and(
          eq(applicationPackages.applicationId, scope.applicationId),
          eq(packages.type, "integration"),
        ),
      );
    const items = await Promise.all(
      installedRows.map(async (row) => {
        const summary = await getIntegration(scope.orgId, row.packageId);
        if (!summary) return null;
        return {
          ...summary,
          enabled: row.enabled,
          installedAt: row.installedAt.toISOString(),
        };
      }),
    );
    return c.json(listResponse(items.filter((x): x is NonNullable<typeof x> => x !== null)));
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
      const { accountId, identityClaims } = extractIdentity(
        manifest,
        result.authKey,
        result.tokenResponse,
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
      return c.json(client);
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
      const body = parseBody(connectOAuthSchema, await c.req.json().catch(() => ({})));

      const auth = await readIntegrationAuth(scope, packageId, authKey);
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
      const client = await loadIntegrationOAuthClientForFlow(scope, packageId, authKey);
      if (!client) {
        throw forbidden(
          `Administrator must register OAuth client credentials for '${packageId}' auth '${authKey}' before connection`,
        );
      }
      const redirectUri = client.redirectUri ?? getOAuthCallbackUrl();
      const scopes = [...(auth.scopes ?? []), ...(body.scopes ?? [])];
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
        // Integration connections don't use the legacy connection_profiles
        // model — we still carry an ID through for the state record shape.
        // Use a fixed sentinel so the field is non-empty.
        connectionProfileId: "integration",
      });
      return c.json({ authUrl: result.authUrl, state: result.state });
    },
  );

  router.delete(
    "/:packageId{@[^/]+/[^/]+}/connections/:connectionId",
    requirePermission("integrations", "disconnect"),
    async (c) => {
      const packageId = c.req.param("packageId")!;
      const connectionId = c.req.param("connectionId")!;
      const scope = getAppScope(c);
      const actor = getActor(c);
      await deleteIntegrationConnection(scope, connectionId, actor);
      await recordAuditFromContext(c, {
        action: "integration.connection.deleted",
        resourceType: "integration_connection",
        resourceId: connectionId,
        before: { packageId },
      });
      return c.json({ disconnected: true });
    },
  );

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

  return router;
}
