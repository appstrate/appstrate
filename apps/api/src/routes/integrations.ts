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
 *   - `GET    /:packageId/auths/:authKey/clients`    — admin: list available OAuth clients
 *   - `PUT    /:packageId/auths/:authKey/default-client` — admin: choose the default client
 *   - `POST   /:packageId/auths/:authKey/oauth-clients`  — admin: register a custom OAuth client
 *   - `PUT    /:packageId/oauth-clients/:clientId`   — admin: rotate a custom OAuth client
 *   - `DELETE /:packageId/oauth-clients/:clientId`   — admin: delete a custom OAuth client
 *   - `POST   /:packageId/auths/:authKey/connect/session` — Porte A: mint a hosted
 *       Connect portal session (interactive, auth-type-agnostic). Primary surface.
 *   - `POST   /:packageId/auths/:authKey/connect/oauth2`  — Porte B (programmatic):
 *       headless OAuth2 start — returns an `auth_url` the caller redirects to itself.
 *   - `POST   /:packageId/auths/:authKey/connect/fields`  — Porte B (programmatic):
 *       import a connection by submitting api_key/basic/custom credentials directly.
 *   - `GET    /callback`                              — OAuth2 callback handler
 *
 * Two connection-establishment surfaces, mirroring the Nango split:
 *   - Porte A — the hosted **Connect** portal: the end-user enters the secret on a
 *     platform-hosted form (or the provider's OAuth screen). The secret never
 *     transits the caller, the model, or the chat bundle. Use from agents/UI.
 *   - Porte B — the **programmatic/headless** surface for backends that already
 *     hold the credential (`connect/fields` = "import a connection") or want to
 *     drive the OAuth redirect themselves (`connect/oauth2`). Server-to-server.
 *
 * Destructive connection delete moved to `DELETE /api/me/connections/:id` — the
 * single owner-scoped entry point. The agent-surface "unlink" button is gone:
 * members switch agent picks via member pins, not by deleting the shared row.
 *
 * The OAuth2 callback renders a popup-close HTML page so the dashboard's
 * connect-window handler can detect completion and refresh.
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import {
  handleIntegrationOAuthCallback,
  OAuthCallbackError,
  type IntegrationOAuthCallbackResult,
} from "@appstrate/connect";
import type { AppEnv } from "../types/index.ts";
import { logger } from "../lib/logger.ts";
import { ApiError, invalidRequest, internalError, notFound } from "../lib/errors.ts";
import { readJsonBody } from "../lib/request-body.ts";
import { listResponse } from "../lib/list-response.ts";
import {
  parseListPagination,
  parseFieldSelection,
  paginate,
  projectFields,
} from "../lib/list-query.ts";
import { setOffsetLinkHeader } from "../lib/pagination-link.ts";
import { popupHtmlClose, popupHtmlError } from "../lib/oauth-popup-html.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import { getActor, type Actor } from "../lib/actor.ts";
import { getAppScope } from "../lib/scope.ts";
import { recordAuditFromContext } from "./../services/audit.ts";
import { updateInstalledPackage } from "../services/application-packages.ts";
import { listIntegrations } from "../services/integration-service.ts";
import {
  assertIsIntegration,
  createIntegrationOAuthClient,
  deleteIntegrationOAuthClient,
  getIntegrationAuthStatuses,
  listIntegrationClients,
  listIntegrationConnections,
  readIntegrationAuth,
  resolveIntegrationActivations,
  serializeIntegrationConnection,
  setDefaultIntegrationClient,
  toPublicClient,
  updateIntegrationOAuthClient,
  usesAutoProvisionedClient,
} from "../services/integration-connections.ts";
import { resolveStrategy } from "../services/connect/registry.ts";
import { createConnectRunExecutor } from "../services/connect/connect-run-launcher.ts";
import { createBrowserConnectRunExecutor } from "../services/connect/browser-run-launcher.ts";
import type { BrowserConnectExecutor } from "../services/connect/browser-strategy.ts";
import { getBrowserConnectExecutor } from "../services/integration-manifest-helpers.ts";
import { getCurrentScopesGranted } from "../services/integration-scope-resolver.ts";
import { isUserConnectionCreationBlocked } from "../services/integration-connection-resolver.ts";
import {
  deleteIntegrationPin,
  listAgentsConsumingIntegration,
  listIntegrationPins,
  loadConnectionOwnership,
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
import {
  buildConnectUrl,
  readConnectToken,
  consumeJti,
  setConnectPageCookie,
  readConnectPageCookie,
  clearConnectPageCookie,
  scopeFromClaims,
  actorFromClaims,
  csrfMatches,
  CONNECT_CSRF_HEADER,
} from "../services/connect/connect-session.ts";

// ─────────────────────────────────────────────
// Zod schemas
// ─────────────────────────────────────────────

// `credentials` is intentionally typed `Record<string, unknown>` here. JSON
// Schema 2020-12 §7.5 permits credential field values of any JSON type
// (numbers, booleans, objects, arrays), and the Zod check at the route layer
// is purely *structural* — tighter shape validation happens against the
// integration manifest's `credentials.schema` (AJV) downstream. Narrowing to
// `Record<string, string>` here would silently reject every well-formed
// non-string credential shape before AJV ever got to see it.
// Porte B programmatic import — the backend already holds the credential and
// submits it directly ("import a connection", Nango `POST /connection`).
export const importConnectionSchema = z.object({
  credentials: z.record(z.string(), z.unknown()).refine((c) => Object.keys(c).length > 0, {
    message: "credentials must contain at least one field",
  }),
  // Renew an existing connection in place (api_key/PAT/custom): the OAuth
  // flow smuggles this on `needs_reconnection`; the fields flow takes the same
  // id so the write UPDATEs the dead row instead of INSERTing a duplicate
  // (single-writer contract, integration-connections.ts:persistCredentialBundle).
  connection_id: z.uuid().optional(),
});

export const connectOAuthSchema = z.object({
  scopes: z.array(z.string()).optional(),
  force_account_select: z.boolean().optional(),
  connection_id: z.uuid().optional(),
});

// Mint a hosted-connect-portal session — auth-type-agnostic (issue #769). The
// caller scopes the connect (optional OAuth scopes + reconnect target); the
// server dispatches OAuth vs credential-form when the URL is opened.
export const connectSessionSchema = z.object({
  scopes: z.array(z.string()).optional(),
  force_account_select: z.boolean().optional(),
  connection_id: z.uuid().optional(),
});

// Hosted-form submit — credentials only; all context comes from the page cookie.
export const connectSubmitSchema = z.object({
  credentials: z.record(z.string(), z.unknown()).refine((c) => Object.keys(c).length > 0, {
    message: "credentials must contain at least one field",
  }),
});

export const setDefaultClientSchema = z.object({
  // The client to make default — a flat client id (system env id or custom
  // `integration_oauth_clients.id`) from `GET .../auths/:authKey/clients`.
  client_ref: z.string().regex(/^[\w.-]+$/, "client_ref must be a client id"),
});

export const updateSettingsSchema = z.object({
  block_user_connections: z.boolean(),
});

export const setPinSchema = z.object({
  connection_id: z.uuid(),
});

export const setOrgDefaultSchema = z.object({
  connection_id: z.uuid(),
  enforce: z.boolean().default(false),
});

export const updateConnectionSchema = z
  .object({
    label: z.string().max(80).nullable().optional(),
    shared_with_org: z.boolean().optional(),
  })
  .refine((b) => b.label !== undefined || b.shared_with_org !== undefined, {
    message: "at least one of label, shared_with_org must be provided",
  });

export const oauthClientSchema = z.object({
  client_id: z.string().min(1),
  client_secret: z.string().default(""),
  redirect_uri: z.url().optional(),
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
  integrationId: string,
): Promise<void> {
  const role = c.get("orgRole");
  if (role === "owner" || role === "admin") return;
  const blocked = await isUserConnectionCreationBlocked(applicationId, integrationId);
  if (blocked) {
    throw new ApiError({
      status: 403,
      code: "connection_blocked_by_admin",
      title: "Connection Blocked by Admin",
      detail: `Creation of personal connections to '${integrationId}' is disabled by the organization admin. Use the shared connection instead.`,
    });
  }
}

/**
 * Guard a client-supplied reconnect target (`connection_id`) against IDOR: the
 * connect flows honor an arbitrary connection id to renew a credential in
 * place, so before that id is trusted we must confirm it is a connection the
 * caller actually owns in THIS application. Without this a caller could pass
 * another actor's (or another app's) connection id and overwrite its
 * credentials through the single-writer persist path. A miss surfaces as a
 * plain 404 so cross-scope existence is never disclosed.
 */
async function assertConnectionBelongsToActor(
  connectionId: string,
  applicationId: string,
  actor: Actor,
): Promise<void> {
  const owner = await loadConnectionOwnership(connectionId);
  const ownedByActor =
    owner !== null &&
    owner.applicationId === applicationId &&
    (actor.type === "user" ? owner.userId === actor.id : owner.endUserId === actor.id);
  if (!ownedByActor) {
    throw notFound("Connection not found");
  }
}

// ─────────────────────────────────────────────
// Router
// ─────────────────────────────────────────────

export interface IntegrationsRouterOptions {
  /** Test seam for the browser acquisition substrate; production uses Docker. */
  browserConnectExecutor?: BrowserConnectExecutor;
}

export function createIntegrationsRouter(options: IntegrationsRouterOptions = {}) {
  const router = new Hono<AppEnv>();

  // ─── List + detail ─────────────────────────

  // Allowlisted projection keys for the `fields` selector — `manifest` is the
  // heavy field (full AFPS manifest per row); dropping it lets a caller that
  // only needs "which integrations exist" fetch a fraction of the payload.
  const INTEGRATION_FIELDS = [
    "id",
    "manifest",
    "orgId",
    "source",
    "active",
    "block_user_connections",
  ] as const;

  router.get("/", requirePermission("integrations", "read"), async (c) => {
    const scope = getAppScope(c);
    const fields = parseFieldSelection(c, INTEGRATION_FIELDS);
    const pagination = parseListPagination(c, { defaultLimit: 100 });
    const summaries = await listIntegrations(scope.orgId);
    // Decorate with `active` + `block_user_connections` flags for the current
    // application via the shared resolver — the single source of truth, also
    // used by the agent-editor detail endpoint, so the two surfaces can never
    // diverge (env-backed SYSTEM integrations stay active on both).
    const activations = await resolveIntegrationActivations(
      summaries.map((s) => s.id),
      scope.applicationId,
    );
    const enriched = summaries.map((s) => {
      const a = activations.get(s.id)!;
      return {
        ...s,
        active: a.active,
        block_user_connections: a.blockUserConnections,
      };
    });
    const { page, total, hasMore } = paginate(enriched, pagination);
    const projected = page.map((row) => projectFields(row, fields, ["id"]));
    setOffsetLinkHeader({ c, limit: pagination.limit, offset: pagination.offset, total });
    return c.json(listResponse(projected, { hasMore, total }));
  });

  router.get("/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    const error = c.req.query("error");
    if (error) {
      logger.warn("Integration OAuth callback received error", { error });
      return c.html(popupHtmlError(`OAuth error: ${error}`, { state }, 3000));
    }
    if (!code || !state) {
      return c.html(popupHtmlError("Missing required parameters", { state }, 3000));
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
          subjectId: err.subjectId,
          kind: err.kind,
          status: err.status,
          oauthError: err.oauthError,
          oauthErrorDescription: err.oauthErrorDescription,
        });
        return c.html(popupHtmlError(userMessage, { state }));
      }
      const msg = err instanceof Error ? err.message : "OAuth callback failed";
      logger.error("Integration OAuth callback failed", { msg });
      return c.html(popupHtmlError(`Error: ${msg}`, { state }));
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
          integrationId: result.packageId,
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
        return c.html(popupHtmlError(err.message, { state, packageId: result.packageId }));
      }
      return c.html(
        popupHtmlError("Could not save the connection.", { state, packageId: result.packageId }),
      );
    }
    return c.html(popupHtmlClose({ state, packageId: result.packageId }));
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
  // Activation is the `application_packages.enabled` flag, NOT row presence.
  // Both routes upsert the flag (never delete the row) so the rule holds
  // uniformly for every integration — including a SYSTEM integration that is
  // auto-active with no row: deleting the row there would re-trigger the
  // auto-active default, so "deactivate" must persist an explicit `enabled =
  // false` opt-out (sticky across runs). For a plain integration the observable
  // result is unchanged (active ⇄ inactive). Deactivation stays non-destructive:
  // connections, OAuth clients, pins and org defaults FK to (package,
  // application) — not to application_packages — so they survive and are reused
  // on reactivation (mirrors how disabling a provider keeps its credentials).

  router.post(
    "/:packageId{@[^/]+/[^/]+}/activate",
    requirePermission("integrations", "install"),
    async (c) => {
      const packageId = c.req.param("packageId")!;
      const scope = getAppScope(c);
      const actor = getActor(c);
      await assertIsIntegration(scope, packageId);
      await updateInstalledPackage(scope, packageId, { enabled: true });
      await recordAuditFromContext(c, {
        action: "integration.activated",
        resourceType: "integration",
        resourceId: packageId,
      });
      // 201 + the bare integration resource — same serializer as
      // GET /integrations/:packageId (issue #657). Activation state is part
      // of the resource (`active`), not an operation scrap.
      const detail = await getIntegrationAuthStatuses(scope, packageId, actor);
      return c.json(detail, 201);
    },
  );

  router.delete(
    "/:packageId{@[^/]+/[^/]+}/deactivate",
    requirePermission("integrations", "uninstall"),
    async (c) => {
      const packageId = c.req.param("packageId")!;
      const scope = getAppScope(c);
      await assertIsIntegration(scope, packageId);
      await updateInstalledPackage(scope, packageId, { enabled: false });
      await recordAuditFromContext(c, {
        action: "integration.deactivated",
        resourceType: "integration",
        resourceId: packageId,
      });
      // 204: deactivation flips `enabled` to false (upsert, so it also works
      // for a never-installed auto-active system integration). Under the strict
      // mutation convention (issue #657) the response is empty. The integration
      // detail stays GET-able — `GET /integrations/:packageId` serves the
      // resource with `active: false`.
      return c.body(null, 204);
    },
  );

  // ─── OAuth client registration (admin) ─────

  // List every OAuth client registered for this auth: the org's custom
  // (BYO-app) clients plus any env-provided system clients, with `source` and
  // which is the default. Secrets are never returned. Drives the admin clients
  // CRUD table (register/rotate/delete/set-default). New connections always use
  // the default — there is no per-connect picker.
  router.get(
    "/:packageId{@[^/]+/[^/]+}/auths/:authKey/clients",
    requirePermission("integrations", "read"),
    async (c) => {
      const packageId = c.req.param("packageId")!;
      const authKey = c.req.param("authKey")!;
      const scope = getAppScope(c);
      // Resolve the integration + auth first so an unknown integration/auth 404s
      // (the spec declares 404 here) instead of leaking an empty client list.
      await readIntegrationAuth(scope, packageId, authKey);
      const clients = await listIntegrationClients(scope, packageId, authKey);
      return c.json(listResponse(clients));
    },
  );

  // Choose which OAuth client is the default for new connections on this auth
  // (the model-provider `setDefaultModel` analogue). Selecting the org's custom
  // client flags it default; selecting a system client un-flags the custom one
  // so the resolution cascade falls to the system client. Returns the refreshed
  // clients list so the UI re-badges the default without a second fetch.
  router.put(
    "/:packageId{@[^/]+/[^/]+}/auths/:authKey/default-client",
    requirePermission("integrations", "install"),
    async (c) => {
      const packageId = c.req.param("packageId")!;
      const authKey = c.req.param("authKey")!;
      const scope = getAppScope(c);
      const body = await readJsonBody(c, setDefaultClientSchema);
      await setDefaultIntegrationClient(scope, packageId, authKey, body.client_ref);
      await recordAuditFromContext(c, {
        action: "integration.default_client.set",
        resourceType: "integration",
        resourceId: `${packageId}#${authKey}`,
      });
      const clients = await listIntegrationClients(scope, packageId, authKey);
      return c.json(listResponse(clients));
    },
  );

  // Register a NEW custom (BYO-app) OAuth client for this auth — repeatable, so
  // an org can hold N clients per auth (model-provider pattern). The first one
  // becomes the default; subsequent ones are non-default until promoted via
  // PUT .../default-client. Returns the created client (secret omitted).
  router.post(
    "/:packageId{@[^/]+/[^/]+}/auths/:authKey/oauth-clients",
    requirePermission("integrations", "install"),
    async (c) => {
      const packageId = c.req.param("packageId")!;
      const authKey = c.req.param("authKey")!;
      const scope = getAppScope(c);
      const body = await readJsonBody(c, oauthClientSchema);
      // Reject a manual client on an auto-provisioned (remote MCP) auth. Its
      // token endpoint only accepts a DCR/CIMD-acquired public client, so a
      // hand-entered client_id points at the wrong OAuth server and, once
      // stored, silently disables auto-registration (ensureIntegrationOAuthClient
      // returns the stale client instead of running DCR) — surfacing later as an
      // opaque `invalid_client` at the authorize redirect. The UI hides the form
      // for these auths; this guards the API/curl path too.
      const { manifest, auth } = await readIntegrationAuth(scope, packageId, authKey);
      if (usesAutoProvisionedClient(manifest, auth)) {
        throw invalidRequest(
          `Integration '${packageId}' auth '${authKey}' provisions its OAuth client automatically at connect time (DCR/CIMD); a manual client must not be registered. Connect without supplying credentials, or delete the existing client to restore auto-registration.`,
        );
      }
      const client = await createIntegrationOAuthClient(scope, packageId, authKey, {
        clientId: body.client_id,
        clientSecret: body.client_secret,
        ...(body.redirect_uri !== undefined ? { redirectUri: body.redirect_uri } : {}),
      });
      await recordAuditFromContext(c, {
        action: "integration.oauth_client.created",
        resourceType: "integration",
        resourceId: `${packageId}#${authKey}#${client.id}`,
      });
      return c.json(toPublicClient(client), 201);
    },
  );

  // Rotate one custom client's credentials in place, by its id. Auto-provisioned
  // (DCR) clients are machine-managed and rejected by the service.
  router.put(
    "/:packageId{@[^/]+/[^/]+}/oauth-clients/:clientId",
    requirePermission("integrations", "install"),
    async (c) => {
      const packageId = c.req.param("packageId")!;
      const clientId = c.req.param("clientId")!;
      if (!z.uuid().safeParse(clientId).success) {
        throw notFound(`OAuth client '${clientId}' not found`);
      }
      const scope = getAppScope(c);
      const body = await readJsonBody(c, oauthClientSchema);
      const client = await updateIntegrationOAuthClient(scope, clientId, {
        clientId: body.client_id,
        clientSecret: body.client_secret,
        ...(body.redirect_uri !== undefined ? { redirectUri: body.redirect_uri } : {}),
      });
      await recordAuditFromContext(c, {
        action: "integration.oauth_client.rotated",
        resourceType: "integration",
        resourceId: `${packageId}#${client.auth_key}#${clientId}`,
      });
      return c.json(toPublicClient(client));
    },
  );

  // Delete one custom client by its id. If it was the default, the resolution
  // cascade falls to the system client (no auto-promotion). Connections pinned
  // to this client are deleted with it (they can never refresh once its
  // credentials are gone) — the audit `after.deletedConnections` records how
  // many.
  router.delete(
    "/:packageId{@[^/]+/[^/]+}/oauth-clients/:clientId",
    requirePermission("integrations", "install"),
    async (c) => {
      const packageId = c.req.param("packageId")!;
      const clientId = c.req.param("clientId")!;
      if (!z.uuid().safeParse(clientId).success) {
        throw notFound(`OAuth client '${clientId}' not found`);
      }
      const scope = getAppScope(c);
      const { deletedConnections } = await deleteIntegrationOAuthClient(scope, clientId);
      await recordAuditFromContext(c, {
        action: "integration.oauth_client.deleted",
        resourceType: "integration",
        resourceId: `${packageId}#${clientId}`,
        after: { deletedConnections },
      });
      return c.body(null, 204);
    },
  );

  // ─── Connect flows ─────────────────────────

  // Porte B — import a connection (programmatic). The caller submits the
  // credential it already holds; the connection is created directly. No hosted
  // form, no end-user interaction. The interactive path is the Connect portal
  // (`connect/session`) — use that whenever a human/agent supplies the secret.
  router.post(
    "/:packageId{@[^/]+/[^/]+}/auths/:authKey/connect/fields",
    requirePermission("integrations", "connect"),
    async (c) => {
      const packageId = c.req.param("packageId")!;
      const authKey = c.req.param("authKey")!;
      const scope = getAppScope(c);
      const actor = getActor(c);
      await assertConnectionCreationAllowed(c, scope.applicationId, packageId);
      const body = await readJsonBody(c, importConnectionSchema);
      // A reconnect target must be the caller's own connection in this app —
      // otherwise the credential write below would overwrite an arbitrary
      // (possibly another actor's) connection (IDOR).
      if (body.connection_id) {
        await assertConnectionBelongsToActor(body.connection_id, scope.applicationId, actor);
      }
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
          browserConnectExecutor: createBrowserConnectRunExecutor(),
        }).complete(
          {
            scope,
            actor,
            integrationId: packageId,
            authKey,
            ...(body.connection_id ? { connectionId: body.connection_id } : {}),
          },
          { kind: "fields", credentials: body.credentials },
        );
        await recordAuditFromContext(c, {
          action: "integration.connection.created",
          resourceType: "integration_connection",
          resourceId: conn.id,
          after: { packageId, authKey, accountId: conn.account_id },
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
      const body = await readJsonBody(c, connectOAuthSchema, { allowEmpty: true });
      // Same reconnect-target IDOR guard as connect/fields: the connection_id is
      // carried into the OAuth state and honored at callback-time write.
      if (body.connection_id) {
        await assertConnectionBelongsToActor(body.connection_id, scope.applicationId, actor);
      }

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
      const granted = body.connection_id
        ? await getCurrentScopesGranted({
            scope,
            integrationId: packageId,
            authKey,
            actor,
            connectionId: body.connection_id,
          })
        : [];
      // AFPS: manifest default scopes are `default_scopes`.
      const defaultScopes = (auth as { default_scopes?: string[] }).default_scopes ?? [];
      const scopes = [...new Set([...defaultScopes, ...(body.scopes ?? []), ...granted])];
      const strategy = resolveStrategy(auth);
      if (!strategy.begin) {
        throw internalError();
      }
      const result = await strategy.begin(
        {
          scope,
          actor,
          integrationId: packageId,
          authKey,
          ...(body.connection_id ? { connectionId: body.connection_id } : {}),
        },
        {
          scopes,
          forceAccountSelect: body.force_account_select ?? false,
        },
      );
      return c.json({ auth_url: result.redirectUrl, state: result.state });
    },
  );

  // ─── Hosted connect portal (issue #769) ────
  //
  // Unified, auth-type-agnostic connect surface. The agent (or any client)
  // mints a session here and receives ONE `connect_url`; opening it dispatches
  // to the provider's OAuth screen (oauth2) or the hosted credential form
  // (api_key/basic/mtls/custom). The credential secret never transits the model
  // or the chat bundle — it is entered directly on the hosted form.
  router.post(
    "/:packageId{@[^/]+/[^/]+}/auths/:authKey/connect/session",
    requirePermission("integrations", "connect"),
    async (c) => {
      const packageId = c.req.param("packageId")!;
      const authKey = c.req.param("authKey")!;
      const scope = getAppScope(c);
      const actor = getActor(c);
      await assertConnectionCreationAllowed(c, scope.applicationId, packageId);
      const body = await readJsonBody(c, connectSessionSchema, { allowEmpty: true });
      // Same reconnect-target IDOR guard as connect/fields: the connection_id is
      // minted into the hosted-connect capability token and honored at write.
      if (body.connection_id) {
        await assertConnectionBelongsToActor(body.connection_id, scope.applicationId, actor);
      }
      // Validate the auth exists (404/409 surfaced now, not after the redirect).
      await readIntegrationAuth(scope, packageId, authKey);
      const { connectUrl, expiresAt } = buildConnectUrl({
        org_id: scope.orgId,
        application_id: scope.applicationId,
        ...(actor.type === "user" ? { user_id: actor.id } : { end_user_id: actor.id }),
        package_id: packageId,
        auth_key: authKey,
        ...(body.connection_id ? { connection_id: body.connection_id } : {}),
        ...(body.scopes ? { scopes: body.scopes } : {}),
        ...(body.force_account_select ? { force_account_select: true } : {}),
      });
      return c.json({ connect_url: connectUrl, expires_at: expiresAt });
    },
  );

  // GET /connect/start?token=… — the single dispatch entry point. Verifies the
  // capability token, consumes its jti (single-use), pins a page cookie, then
  // redirects: oauth2 → provider screen; else → the hosted SPA form at /connect.
  router.get("/connect/start", async (c) => {
    // The single-use capability token rides this request's query string. Strip
    // the Referer entirely so the token can never leak to the provider (oauth2
    // redirect) or any downstream navigation — defence in depth on top of the
    // single-use jti + short TTL (the modern default policy already drops the
    // query cross-origin, but `no-referrer` removes the origin too).
    c.header("Referrer-Policy", "no-referrer");
    const token = c.req.query("token");
    if (!token) return c.html(popupHtmlError("Missing connect token", {}, 4000), 400);
    const claims = readConnectToken(token);
    if (!claims) return c.html(popupHtmlError("This connect link is invalid or expired.", {}), 410);
    const scope = scopeFromClaims(claims);
    const actor = actorFromClaims(claims);
    // Resolve the integration BEFORE consuming the jti — if the auth no longer
    // exists, the capability token stays unburned so the caller can retry once
    // the integration is back, rather than being forced to re-mint.
    let auth: Awaited<ReturnType<typeof readIntegrationAuth>>["auth"];
    try {
      ({ auth } = await readIntegrationAuth(scope, claims.package_id, claims.auth_key));
    } catch {
      return c.html(popupHtmlError("This integration is no longer available.", {}), 410);
    }
    // Single-use: burn the jti only once we know the link is actionable.
    if (!(await consumeJti(claims.jti, claims.exp))) {
      return c.html(popupHtmlError("This connect link has already been used.", {}), 410);
    }

    if (auth.type === "oauth2") {
      // Same scope-union semantics as POST /connect/oauth2.
      const granted = claims.connection_id
        ? await getCurrentScopesGranted({
            scope,
            integrationId: claims.package_id,
            authKey: claims.auth_key,
            actor,
            connectionId: claims.connection_id,
          })
        : [];
      const defaultScopes = (auth as { default_scopes?: string[] }).default_scopes ?? [];
      const scopes = [...new Set([...defaultScopes, ...(claims.scopes ?? []), ...granted])];
      const strategy = resolveStrategy(auth);
      if (!strategy.begin) {
        return c.html(popupHtmlError("This integration cannot be connected.", {}), 500);
      }
      // `begin` can throw on a transient/structural fault (OAuth client removed
      // between mint and click, provider discovery error, network). Without this
      // guard the throw escapes to the global error handler, which renders raw
      // `application/problem+json` inside the popup instead of the friendly
      // popupHtmlError page every other failure path here returns. The jti is
      // already burned, so the user re-mints (one click) — surface a readable
      // error rather than a JSON blob.
      let result: Awaited<ReturnType<NonNullable<typeof strategy.begin>>>;
      try {
        result = await strategy.begin(
          {
            scope,
            actor,
            integrationId: claims.package_id,
            authKey: claims.auth_key,
            ...(claims.connection_id ? { connectionId: claims.connection_id } : {}),
          },
          { scopes, forceAccountSelect: claims.force_account_select ?? false },
        );
      } catch (err) {
        logger.error("Hosted connect OAuth begin failed", {
          err: String(err),
          packageId: claims.package_id,
          authKey: claims.auth_key,
        });
        return c.html(popupHtmlError("Could not start the connection. Please try again.", {}), 502);
      }
      return c.redirect(result.redirectUrl);
    }

    // Non-oauth → hand off to the hosted SPA form. Pin the page cookie so the
    // form can read context via GET /connect/context (no token in the URL). The
    // oauth2 branch above never reaches here, so the cookie is set only when the
    // hosted form actually needs it.
    setConnectPageCookie(c, claims);
    return c.redirect("/connect");
  });

  // GET /connect/context — the hosted SPA form reads its render context here
  // (page cookie). Returns the auth manifest + display metadata, never a secret.
  router.get("/connect/context", async (c) => {
    const claims = readConnectPageCookie(c);
    if (!claims) throw notFound("No active connect session");
    const scope = scopeFromClaims(claims);
    const { manifest, auth } = await readIntegrationAuth(scope, claims.package_id, claims.auth_key);
    return c.json({
      package_id: claims.package_id,
      auth_key: claims.auth_key,
      display_name: manifest.display_name ?? claims.package_id,
      icon: manifest.icon ?? null,
      auth,
      connection_id: claims.connection_id ?? null,
      csrf: claims.csrf ?? null,
    });
  });

  // POST /connect/submit — hosted-form credential submit. Context + actor come
  // from the page cookie; the request carries only the credentials + CSRF nonce.
  router.post("/connect/submit", async (c) => {
    const claims = readConnectPageCookie(c);
    if (!claims) throw notFound("No active connect session");
    // Double-submit CSRF: the nonce minted into the page cookie must match the
    // header the SPA echoes back (read from GET /connect/context). Compared in
    // constant time so the nonce can't be recovered by timing.
    if (!csrfMatches(claims, c.req.header(CONNECT_CSRF_HEADER))) {
      throw invalidRequest("Invalid or missing CSRF token");
    }
    const scope = scopeFromClaims(claims);
    const actor = actorFromClaims(claims);
    const body = await readJsonBody(c, connectSubmitSchema, { allowEmpty: true });
    const { auth } = await readIntegrationAuth(scope, claims.package_id, claims.auth_key);
    if (auth.type === "oauth2") {
      throw invalidRequest("This integration uses OAuth — open the connect link instead");
    }
    const strategy = resolveStrategy(auth, {
      connectToolExecutor: createConnectRunExecutor(),
      browserConnectExecutor: options.browserConnectExecutor ?? createBrowserConnectRunExecutor(),
    });
    const connectContext = {
      scope,
      actor,
      integrationId: claims.package_id,
      authKey: claims.auth_key,
      ...(claims.connection_id ? { connectionId: claims.connection_id } : {}),
    };

    // Browser acquisition may pause for DataDome/2FA. Keep this POST open as
    // an SSE stream so the sidecar's encrypted live-view event can reach the
    // user while the same browser session and trusted driver continue running.
    if (getBrowserConnectExecutor(auth.connect)) {
      clearConnectPageCookie(c);
      const response = streamSSE(c, async (stream) => {
        const abort = new AbortController();
        stream.onAbort(() => abort.abort());
        try {
          const conn = await strategy.complete(
            {
              ...connectContext,
              signal: abort.signal,
              onBrowserInteractionRequired: async ({ url }) => {
                if (stream.aborted) throw new Error("hosted connect client disconnected");
                await stream.writeSSE({
                  event: "interaction",
                  data: JSON.stringify({ url }),
                });
              },
            },
            { kind: "fields", credentials: body.credentials },
          );
          if (!stream.aborted) {
            await stream.writeSSE({
              event: "complete",
              data: JSON.stringify({ ok: true, connection: conn }),
            });
          }
        } catch (err) {
          if (stream.aborted) return;
          if (!(err instanceof ApiError)) {
            logger.error("Hosted browser connect submit failed", {
              err: String(err),
              packageId: claims.package_id,
              authKey: claims.auth_key,
            });
          }
          const problem =
            err instanceof ApiError
              ? { status: err.status, code: err.code, detail: err.message }
              : {
                  status: 500,
                  code: "internal_error",
                  detail: "The browser connection could not be completed.",
                };
          await stream.writeSSE({ event: "error", data: JSON.stringify(problem) });
        }
      });
      // Hono's streamSSE defaults to `no-cache`; this stream temporarily
      // carries a capability URL, so forbid browser/proxy persistence.
      c.header("Cache-Control", "no-store");
      response.headers.set("Cache-Control", "no-store");
      return response;
    }

    try {
      const conn = await strategy.complete(connectContext, {
        kind: "fields",
        credentials: body.credentials,
      });
      clearConnectPageCookie(c);
      return c.json({ ok: true, connection: conn });
    } catch (err) {
      if (err instanceof ApiError) throw err;
      logger.error("Hosted connect submit failed", { err: String(err) });
      throw internalError();
    }
  });

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

  // The per-integration agent-resolution verdict is now served in bulk by
  // GET /api/agents/:scope/:name/connection-readiness (one call per agent).

  // ─── Admin: block_user_connections + pins + connection metadata ──

  router.patch(
    "/:packageId{@[^/]+/[^/]+}/settings",
    requirePermission("integrations", "install"),
    async (c) => {
      assertOrgAdmin(c);
      const packageId = c.req.param("packageId")!;
      const scope = getAppScope(c);
      const actor = getActor(c);
      await assertIsIntegration(scope, packageId);
      const body = await readJsonBody(c, updateSettingsSchema);
      const result = await setBlockUserConnections(scope, packageId, body.block_user_connections);
      await recordAuditFromContext(c, {
        action: "integration.block_user_connections.updated",
        resourceType: "integration",
        resourceId: packageId,
        after: { blocked: result.blocked },
      });
      // 200 + the bare integration resource — same serializer as
      // GET /integrations/:packageId; the toggled gate is part of the
      // resource (`block_user_connections`), not an operation scrap (#657).
      const detail = await getIntegrationAuthStatuses(scope, packageId, actor);
      return c.json(detail);
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
      const body = await readJsonBody(c, setPinSchema);
      const userId = c.get("user")?.id ?? null;
      const pin = await upsertIntegrationPin(scope, packageId, {
        agentPackageId,
        connectionId: body.connection_id,
        createdBy: userId,
      });
      await recordAuditFromContext(c, {
        action: "integration.pin.upserted",
        resourceType: "integration_pin",
        resourceId: `${packageId}#${agentPackageId}`,
        after: { connectionId: pin.connection_id },
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
      // Idempotent delete — 204 whether the pin existed or not.
      return c.body(null, 204);
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
      // Bare resource, or 204 when no default is set — same contract as
      // PUT (bare resource) and the models/proxies default endpoints (#657).
      if (!item) return c.body(null, 204);
      return c.json(item);
    },
  );

  router.put(
    "/:packageId{@[^/]+/[^/]+}/default",
    requirePermission("integrations", "install"),
    async (c) => {
      assertOrgAdmin(c);
      const packageId = c.req.param("packageId")!;
      const scope = getAppScope(c);
      const body = await readJsonBody(c, setOrgDefaultSchema);
      const userId = c.get("user")?.id ?? null;
      const def = await upsertOrgDefault(scope, packageId, {
        connectionId: body.connection_id,
        enforce: body.enforce,
        createdBy: userId,
      });
      await recordAuditFromContext(c, {
        action: "integration.org_default.upserted",
        resourceType: "integration_org_default",
        resourceId: packageId,
        after: { connectionId: def.connection_id, enforce: def.enforce },
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
      // Idempotent delete — 204 whether a default existed or not.
      return c.body(null, 204);
    },
  );

  router.patch(
    "/:packageId{@[^/]+/[^/]+}/connections/:connectionId",
    requirePermission("integrations", "connect"),
    async (c) => {
      const connectionId = c.req.param("connectionId")!;
      const scope = getAppScope(c);
      const actor = getActor(c);
      // `connectionId` hits a `uuid` column — a non-UUID raises PG `22P02` and
      // surfaces as a 500. Validate first and collapse to the same `notFound`
      // the missing-row branch returns (no information leak / no 500).
      if (!z.uuid().safeParse(connectionId).success) {
        throw notFound(`Connection '${connectionId}' not found`);
      }
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
      const body = await readJsonBody(c, updateConnectionSchema);
      if (body.shared_with_org !== undefined && !isOwner) {
        throw new ApiError({
          status: 403,
          code: "forbidden",
          title: "Forbidden",
          detail: "Only the connection owner can change shared_with_org",
        });
      }
      const updated = await updateConnectionMetadata(connectionId, {
        ...(body.label !== undefined ? { label: body.label } : {}),
        ...(body.shared_with_org !== undefined ? { sharedWithOrg: body.shared_with_org } : {}),
      });
      await recordAuditFromContext(c, {
        action: "integration.connection.metadata.updated",
        resourceType: "integration_connection",
        resourceId: connectionId,
        after: {
          ...(body.label !== undefined ? { label: body.label } : {}),
          ...(body.shared_with_org !== undefined ? { sharedWithOrg: body.shared_with_org } : {}),
        },
      });
      // 200 + the bare connection resource — same serializer as the
      // connections list / connect flows (#657), not a hand-built stub.
      return c.json(serializeIntegrationConnection(updated));
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
