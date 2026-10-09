// SPDX-License-Identifier: Apache-2.0

/**
 * AFPS integration marketplace REST surface.
 *
 * Routes (all mounted under `/api/integrations`, space-scoped):
 *
 *   - `GET    /`                                     — list available + active status
 *
 * Activating and deactivating an integration are NOT here: they are the same
 * act as activating any other package type, on the one pair of doors that
 * spells it — `POST /api/spaces/{spaceId}/packages` and
 * `DELETE /api/spaces/{spaceId}/packages/{scope}/{name}` (RBAC spec §6.10).
 *   - `GET    /:packageId`                           — manifest + per-auth status for caller
 *   - `GET    /:packageId/auths/:authKey/clients`    — admin: list available OAuth clients
 *   - `PUT    /:packageId/auths/:authKey/default-client` — admin: choose the default client
 *   - `POST   /:packageId/auths/:authKey/oauth-clients`  — admin: register a custom OAuth client
 *   - `PATCH  /:packageId/oauth-clients/:clientId`   — admin: update a custom OAuth client
 *   - `DELETE /:packageId/oauth-clients/:clientId`   — admin: delete a custom OAuth client
 *   - `POST   /:packageId/oauth-clients/:clientId/promote` — admin: move it to the org tier
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
 * Destructive connection delete is not on this surface: it is owner-scoped, on
 * `DELETE /api/me/connections/:connectionId`, as the single entry point. From
 * here members switch an agent's pick via member pins, which is a different
 * operation from deleting the shared row.
 *
 * The OAuth2 callback renders a popup-close HTML page so the dashboard's
 * connect-window handler can detect completion and refresh.
 */

import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import {
  handleIntegrationOAuthCallback,
  OAuthCallbackError,
  type IntegrationOAuthCallbackResult,
  type OAuthClientResolver,
} from "@appstrate/connect";
import type { AppEnv } from "../types/index.ts";
import type { IntegrationConnection, IntegrationOAuthClient } from "@appstrate/shared-types";
import { logger } from "../lib/logger.ts";
import {
  ApiError,
  invalidRequest,
  internalError,
  notFound,
  validationFailed,
} from "../lib/errors.ts";
import { readJsonBody } from "@appstrate/core/request-body";
import { listResponse } from "../lib/list-response.ts";
import {
  parseListPagination,
  parseFieldSelection,
  paginate,
  projectFields,
} from "../lib/list-query.ts";
import { setOffsetLinkHeader } from "../lib/pagination-link.ts";
import { popupHtmlClose, popupHtmlError } from "../lib/oauth-popup-html.ts";
import { normalizeOAuthErrorCode, oauthDiagnosticSuffix } from "../lib/oauth-error-diagnostic.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import { rateLimit, rateLimitByIp } from "../middleware/rate-limit.ts";
import { getActor, type Actor } from "../lib/actor.ts";
import { isUserPrincipal } from "../lib/principal.ts";
import { callerPermissionsInSpace } from "../lib/view-as.ts";
import { getSpaceScope, type OrgScope, type SpaceScope } from "../lib/scope.ts";
import type { AuditPayload } from "@appstrate/core/module";
import { auditDiff, recordAuditAs, recordAuditFromContext } from "./../services/audit.ts";
import { listIntegrations } from "../services/integration-service.ts";
import {
  assertConnectionBelongsToActor,
  assertIsIntegration,
  createIntegrationOAuthClient,
  deleteIntegrationOAuthClient,
  getIntegrationAuthStatuses,
  getIntegrationConnectionCredentialFields,
  getIntegrationConnectionVariables,
  listIntegrationClients,
  listIntegrationConnections,
  promoteIntegrationOAuthClient,
  readIntegrationAuth,
  resolveIntegrationActivations,
  resolveIntegrationClientById,
  serializeIntegrationConnection,
  setDefaultIntegrationClient,
  toPublicClient,
  updateIntegrationOAuthClient,
  usesAutoProvisionedClient,
} from "../services/integration-connections.ts";
import { resolveStrategy } from "../services/connect/registry.ts";
import type {
  ConnectCompleteInput,
  ConnectContext,
  IntegrationConnectStrategy,
} from "../services/connect/strategy.ts";
import {
  authWithoutMintedCredentials,
  handoffStepsFor,
  provisionCredentials,
  readProvisioning,
} from "../services/connect/provisioning.ts";
import { createConnectRunExecutor } from "../services/connect/connect-run-launcher.ts";
import { getCurrentScopesGranted } from "../services/integration-scope-resolver.ts";
import { isUserConnectionCreationBlocked } from "../services/integration-connection-resolver.ts";
import { removeScheduleJobs } from "../services/scheduler.ts";
import {
  CLIENT_SECRET_REQUIRED_MESSAGE,
  PUBLIC_CLIENT_WITH_SECRET_MESSAGE,
  getVariablesSchema,
} from "../services/integration-manifest-helpers.ts";
import { partitionScopesByAuthCatalog, scopesNotCovered } from "@appstrate/core/integration";
import { connectionIdSetSchema, nonEmptyConnectionIdSetSchema } from "../lib/connection-set.ts";
import { CONNECTION_LABEL_MAX, connectionLabelProblem } from "../lib/connection-label.ts";
import {
  deletePin,
  listAgentsConsumingIntegration,
  listIntegrationPins,
  pinAudit,
  pinAuditResourceId,
  setBlockUserConnections,
  updateConnection,
  upsertIntegrationPin,
  type ConnectionViewer,
} from "../services/integration-pins-service.ts";
import {
  getOrgDefault,
  upsertOrgDefault,
  deleteOrgDefault,
} from "../services/integration-org-defaults-service.ts";
import { oauthStateStore } from "../services/connect/oauth-state-store.ts";
import {
  buildConnectUrl,
  connectClaimsFor,
  readConnectToken,
  consumeJti,
  releaseJti,
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
// Connection variables (AFPS §7.12): non-secret strings choosing the upstream. Names, values and
// the manifest's `variables.schema` are checked by `resolveConnectionVariables`; this bounds size.
const connectionVariablesSchema = z.record(z.string().max(64), z.string().max(2048));

// Porte B programmatic import — the backend already holds the credential and
// submits it directly ("import a connection", Nango `POST /connection`).
export const importConnectionSchema = z
  .object({
    credentials: z.record(z.string(), z.unknown()).refine((c) => Object.keys(c).length > 0, {
      message: "credentials must contain at least one field",
    }),
    // Renew an existing connection in place (api_key/PAT/custom): the OAuth
    // flow smuggles this on `needs_reconnection`; the fields flow takes the same
    // id so the write UPDATEs the dead row instead of INSERTing a duplicate
    // (single-writer contract, integration-connections.ts:persistCredentialBundle).
    connection_id: z.uuid().optional(),
    // Required iff the integration declares variables, a reconnect included.
    variables: connectionVariablesSchema.optional(),
  })
  .strict();

export const connectOAuthSchema = z
  .object({
    scopes: z.array(z.string()).optional(),
    force_account_select: z.boolean().optional(),
    connection_id: z.uuid().optional(),
    variables: connectionVariablesSchema.optional(),
  })
  .strict();

// Mint a hosted-connect-portal session — auth-type-agnostic (issue #769). The
// caller scopes the connect (optional OAuth scopes + reconnect target); the
// server dispatches OAuth vs credential-form when the URL is opened.
export const connectSessionSchema = z
  .object({
    scopes: z.array(z.string()).optional(),
    force_account_select: z.boolean().optional(),
    connection_id: z.uuid().optional(),
  })
  .strict();

// Hosted-form submit — credentials (none for an oauth2 auth) and connection variables; all
// context comes from the page cookie.
export const connectSubmitSchema = z
  .object({
    credentials: z
      .record(z.string(), z.unknown())
      .refine((c) => Object.keys(c).length > 0, {
        message: "credentials must contain at least one field",
      })
      .optional(),
    variables: connectionVariablesSchema.optional(),
  })
  .strict();

export const setDefaultClientSchema = z
  .object({
    // The client to make default — a flat client id (system env id or custom
    // `integration_oauth_clients.id`) from `GET .../auths/:authKey/clients`.
    client_ref: z.string().regex(/^[\w.-]+$/, "client_ref must be a client id"),
  })
  .strict();

export const updateSettingsSchema = z
  .object({
    block_user_connections: z.boolean(),
  })
  .strict();

export const setPinSchema = z
  .object({
    connection_ids: connectionIdSetSchema,
  })
  .strict();

export const setOrgDefaultSchema = z
  .object({
    connection_ids: nonEmptyConnectionIdSetSchema,
    enforce: z.boolean().default(false),
  })
  .strict();

export const updateConnectionSchema = z
  .object({
    label: z
      .string()
      .min(1)
      .max(CONNECTION_LABEL_MAX)
      .superRefine((label, ctx) => {
        const problem = connectionLabelProblem(label);
        if (problem) ctx.addIssue({ code: "custom", message: `label ${problem}` });
      })
      .optional(),
    shared_space_ids: z
      .array(z.string().min(1).max(100))
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: "must not repeat a space id",
      })
      .optional(),
  })
  .strict()
  .refine((b) => b.label !== undefined || b.shared_space_ids !== undefined, {
    message: "at least one of label, shared_space_ids must be provided",
  });

const oauthClientSchema = z
  .object({
    client_id: z.string().min(1),
    /**
     * Shared shape only — the concrete bodies below layer their own semantics on
     * top with refinements (create: required unless public; update: absent means
     * PRESERVE). Deliberately optional here so no derived schema can inherit a
     * default that manufactures a secret nobody typed.
     */
    client_secret: z.string().optional(),
    /**
     * The admin's explicit declaration for THIS client, overriding the
     * manifest's. `"none"` registers a PUBLIC client — the app has no secret at
     * the provider and authenticates by `client_id` alone.
     *
     * Explicit rather than inferred from an empty `client_secret`: that
     * inference could not tell "declared public" from "secret not supplied", and
     * silently produced a token request carrying `client_secret=` that providers
     * like Dropbox reject with `invalid_client`.
     */
    token_endpoint_auth_method: z
      .enum(["client_secret_post", "client_secret_basic", "none"])
      .optional(),
    redirect_uri: z.url().optional(),
  })
  .strict();

/**
 * Shared by both bodies below: `"none"` declares a PUBLIC client, so a secret
 * sent alongside it means the caller resolved a credential and then said it
 * would not be used.
 */
const noSecretWithPublicClient = (b: {
  token_endpoint_auth_method?: string;
  client_secret?: string;
}) => !(b.token_endpoint_auth_method === "none" && (b.client_secret ?? "").length > 0);

/**
 * Registration body. A public client is DECLARED
 * (`token_endpoint_auth_method: "none"`), never inferred from an absent or
 * blank `client_secret` — so both directions of the pair are guarded:
 *
 *   - `"none"` WITH a secret → the caller resolved a credential and then said
 *     it would not be used;
 *   - a secret-based method (or no method at all, which means "the manifest's
 *     method applies") WITHOUT a secret → the request that cannot succeed.
 *     This is the one that used to return 201: `client_secret` defaulted to
 *     `""` and the storage encoder read that emptiness as "public", so an
 *     admin who declared `client_secret_basic` and forgot the secret got a
 *     PUBLIC client back and a token endpoint answering HTTP 400 later.
 */
export const oauthClientCreateSchema = oauthClientSchema
  .refine(noSecretWithPublicClient, {
    message: PUBLIC_CLIENT_WITH_SECRET_MESSAGE,
    path: ["client_secret"],
  })
  .refine((b) => b.token_endpoint_auth_method === "none" || (b.client_secret ?? "").length > 0, {
    message: CLIENT_SECRET_REQUIRED_MESSAGE,
    path: ["client_secret"],
  });

/**
 * Update body, merge semantics: absent = unchanged, `null` clears `redirect_uri`.
 * `client_secret` and `token_endpoint_auth_method` are written as a pair. No
 * `client_id`: a new `client_id` is a new client.
 */
export const oauthClientUpdateSchema = oauthClientSchema
  .omit({ client_id: true })
  .extend({ redirect_uri: z.url().nullable().optional() })
  .refine(noSecretWithPublicClient, {
    message: PUBLIC_CLIENT_WITH_SECRET_MESSAGE,
    path: ["client_secret"],
  })
  // An EXPLICIT empty string is a destructive statement — it clears the stored
  // ciphertext — so it is only accepted alongside the declaration that makes it
  // coherent. Absence stays untouched by this rule: it is the preserve path.
  .refine((b) => !(b.client_secret === "" && b.token_endpoint_auth_method !== "none"), {
    message:
      "an empty client_secret clears the stored credential and is only accepted together with token_endpoint_auth_method='none'; omit the field entirely to preserve the stored secret",
    path: ["client_secret"],
  });

function toOAuthClientCreateInput(body: z.infer<typeof oauthClientCreateSchema>) {
  return {
    clientId: body.client_id,
    // `?? ""` is reachable only for a declared public client: the schema
    // refuses an absent secret under any other method, so the blank never
    // stands in for one the admin meant to supply.
    clientSecret: body.client_secret ?? "",
    ...(body.token_endpoint_auth_method !== undefined
      ? { tokenEndpointAuthMethod: body.token_endpoint_auth_method }
      : {}),
    ...(body.redirect_uri !== undefined ? { redirectUri: body.redirect_uri } : {}),
  };
}

function toOAuthClientUpdateInput(body: z.infer<typeof oauthClientUpdateSchema>) {
  return {
    ...(body.client_secret !== undefined ? { clientSecret: body.client_secret } : {}),
    ...(body.token_endpoint_auth_method !== undefined
      ? { tokenEndpointAuthMethod: body.token_endpoint_auth_method }
      : {}),
    ...(body.redirect_uri !== undefined ? { redirectUri: body.redirect_uri } : {}),
  };
}

/** The audited view of a client: never the secret, only whether one is stored. */
function auditedClient(client: IntegrationOAuthClient) {
  return {
    clientId: client.client_id,
    tokenEndpointAuthMethod: client.token_endpoint_auth_method,
    redirectUri: client.redirect_uri,
    hasClientSecret: client.has_client_secret,
  };
}

/** A custom client id is a row UUID: anything else cannot exist → 404. */
function assertOAuthClientRowId(clientId: string): string {
  if (!z.uuid().safeParse(clientId).success) {
    throw notFound(`OAuth client '${clientId}' not found`);
  }
  return clientId;
}

/**
 * The OAuth client handlers of one tier, registered on the same paths by this
 * router (space) and `routes/org-integrations.ts` (org); the audit row's
 * `spaceId` tells the tiers apart. Each router registers them itself so the
 * `verify:openapi` route scan sees every path.
 */
export function oauthClientHandlers(
  scopeOf: (c: Context<AppEnv>) => SpaceScope | OrgScope,
  packageIdOf: (c: Context<AppEnv>) => string,
) {
  return {
    async list(c: Context<AppEnv>) {
      const packageId = packageIdOf(c);
      const authKey = c.req.param("authKey")!;
      const scope = scopeOf(c);
      // 404 an unknown integration/auth rather than list nothing (the org tier's service does).
      if ("spaceId" in scope) await readIntegrationAuth(scope, packageId, authKey);
      return c.json(listResponse(await listIntegrationClients(scope, packageId, authKey)));
    },

    async setDefault(c: Context<AppEnv>) {
      const packageId = packageIdOf(c);
      const authKey = c.req.param("authKey")!;
      const scope = scopeOf(c);
      const body = await readJsonBody(c, setDefaultClientSchema);
      await setDefaultIntegrationClient(scope, packageId, authKey, body.client_ref);
      await recordAuditFromContext(c, {
        action: "integration.default_client.set",
        resourceType: "integration",
        resourceId: `${packageId}#${authKey}`,
      });
      return c.json(listResponse(await listIntegrationClients(scope, packageId, authKey)));
    },

    async create(c: Context<AppEnv>) {
      const packageId = packageIdOf(c);
      const authKey = c.req.param("authKey")!;
      const body = await readJsonBody(c, oauthClientCreateSchema);
      const client = await createIntegrationOAuthClient(
        scopeOf(c),
        packageId,
        authKey,
        toOAuthClientCreateInput(body),
      );
      await recordAuditFromContext(c, {
        action: "integration.oauth_client.created",
        resourceType: "integration",
        resourceId: `${packageId}#${authKey}#${client.id}`,
        after: auditedClient(client),
      });
      return c.json(toPublicClient(client), 201);
    },

    async update(c: Context<AppEnv>) {
      const packageId = packageIdOf(c);
      const clientId = assertOAuthClientRowId(c.req.param("clientId")!);
      const body = await readJsonBody(c, oauthClientUpdateSchema);
      const { previous, client } = await updateIntegrationOAuthClient(
        scopeOf(c),
        packageId,
        clientId,
        toOAuthClientUpdateInput(body),
      );
      await recordAuditFromContext(c, {
        action: "integration.oauth_client.updated",
        resourceType: "integration",
        resourceId: `${packageId}#${client.auth_key}#${clientId}`,
        before: auditedClient(previous),
        after: {
          ...auditedClient(client),
          clientSecretReplaced: body.client_secret !== undefined,
        },
      });
      return c.json(toPublicClient(client));
    },

    async remove(c: Context<AppEnv>) {
      const packageId = packageIdOf(c);
      const clientId = assertOAuthClientRowId(c.req.param("clientId")!);
      const { client, deletedConnections, disabledScheduleIds } =
        await deleteIntegrationOAuthClient(scopeOf(c), packageId, clientId);
      await removeScheduleJobs(disabledScheduleIds);
      await recordAuditFromContext(c, {
        action: "integration.oauth_client.deleted",
        resourceType: "integration",
        resourceId: `${packageId}#${client.auth_key}#${clientId}`,
        before: auditedClient(client),
        after: { deletedConnections, disabledScheduleIds },
      });
      return c.body(null, 204);
    },
  };
}

// ─────────────────────────────────────────────
// Guards
// ─────────────────────────────────────────────

/**
 * Refuse a connection-creation attempt when the (space, integration)
 * has `block_user_connections=true` and the caller is not allowed to
 * govern this integration.
 *
 * Workflow this enables: an admin toggles the gate → connects → shares the
 * connection into the space → members are funnelled onto the shared
 * connection via the resolver's fallback path. Members trying to bypass
 * with their own connection get a clean 403 instead of a silent override.
 *
 * The exemption is `integrations:configure` — the very permission that sets
 * the gate. Whoever can turn it on can connect while it is on, which is the
 * whole point (otherwise nobody could create the shared connection).
 *
 * `configure` is session-only, so no API key can hold it — however privileged
 * its creator. A key hitting this path gets the 403 the gate exists to produce.
 */
async function assertConnectionCreationAllowed(
  c: import("hono").Context<AppEnv>,
  spaceId: string,
  integrationId: string,
): Promise<void> {
  if (canConfigureIntegrations(c)) return;
  const blocked = await isUserConnectionCreationBlocked(spaceId, integrationId);
  if (blocked) {
    throw new ApiError({
      status: 403,
      code: "connection_blocked_by_admin",
      title: "Connection Blocked by Admin",
      detail: `Creation of personal connections to '${integrationId}' is disabled by an admin of this space. Use the shared connection instead.`,
    });
  }
}

/** The audited view of an org default. */
function orgDefaultAudit(
  def: { connection_ids: string[]; enforce: boolean } | null,
): AuditPayload | null {
  return def ? { connectionIds: def.connection_ids, enforce: def.enforce } : null;
}

/**
 * Guard the caller-supplied `scopes` on both caller-facing kickoffs against the
 * auth's `scope_catalog` (§7.4). `body.scopes` is the ONLY delta the caller
 * contributes to the consent request (defaults and already-granted scopes are
 * computed server-side), so a typo there is otherwise carried all the way to
 * the provider's consent screen, where it fails as an opaque `invalid_scope`.
 * Membership (and the no-catalog carve-out) is `partitionScopesByAuthCatalog`.
 */
function assertScopesInAuthCatalog(
  auth: { scope_catalog?: readonly { value: string }[] },
  authKey: string,
  scopes: readonly string[] | undefined,
): void {
  const { undeclared } = partitionScopesByAuthCatalog(auth, scopes);
  if (undeclared.length === 0) return;
  throw validationFailed([
    {
      field: "scopes",
      code: "scope_not_in_catalog",
      title: "Scope Not in Catalog",
      message: `Scopes not declared in scope_catalog of auth '${authKey}': ${undeclared.join(", ")}`,
    },
  ]);
}

/**
 * Complete a connect door's write and build its audit event. A reconnect renews the credential in
 * place and records the granted scopes when it changed them, since they reach every agent the
 * connection serves; the scopes before are a best-effort read ahead of the write.
 */
async function completeConnect(
  strategy: IntegrationConnectStrategy,
  ctx: ConnectContext,
  input: ConnectCompleteInput,
) {
  const scopesBefore = ctx.connectionId
    ? await getCurrentScopesGranted({ ...ctx, connectionId: ctx.connectionId })
    : null;
  const conn = await strategy.complete(ctx, input);
  const after = { packageId: ctx.integrationId, authKey: ctx.authKey, accountId: conn.account_id };
  const scopes =
    scopesBefore &&
    auditDiff({ scopesGranted: [[...scopesBefore].sort(), [...conn.scopes_granted].sort()] });
  const audit = {
    action: scopesBefore ? "integration.connection.reconnected" : "integration.connection.created",
    resourceType: "integration_connection",
    resourceId: conn.id,
    ...(scopes ? { before: scopes.before, after: { ...after, ...scopes.after } } : { after }),
  };
  return { conn, audit };
}

/** The OAuth state holds only `clientRef`; the callback resolves it as token refresh does. */
const resolveCallbackClient: OAuthClientResolver = async (ref) => {
  const { auth } = await readIntegrationAuth(
    { orgId: ref.orgId, spaceId: ref.spaceId },
    ref.packageId,
    ref.authKey,
  );
  return resolveIntegrationClientById(
    ref.clientRef,
    ref.spaceId,
    ref.packageId,
    ref.authKey,
    auth.token_endpoint_auth_method,
  );
};

type IntegrationAuthDef = Awaited<ReturnType<typeof readIntegrationAuth>>["auth"];
type IntegrationManifestDef = Awaited<ReturnType<typeof readIntegrationAuth>>["manifest"];
type ConnectSessionClaims = NonNullable<ReturnType<typeof readConnectToken>>;

/**
 * The scopes a connect requests: the manifest's `default_scopes`, the caller's, and — on a reconnect
 * — those already granted on the target connection, so an upgrade never silently shrinks.
 * `default_scopes` is the baseline of every connection of the auth (identity, refresh, least
 * capability); `requested` only widens it (afps-spec/afps-spec#34).
 */
async function connectScopes(
  input: { scope: SpaceScope; actor: Actor; integrationId: string; authKey: string },
  auth: IntegrationAuthDef,
  requested: readonly string[] | undefined,
  connectionId: string | undefined,
): Promise<string[]> {
  const granted = connectionId ? await getCurrentScopesGranted({ ...input, connectionId }) : [];
  const defaultScopes = (auth as { default_scopes?: string[] }).default_scopes ?? [];
  return [...new Set([...defaultScopes, ...(requested ?? []), ...granted])];
}

type HostedOAuthBegin =
  | { redirectUrl: string }
  /** A client-side refusal; `reusable` when it provably preceded any egress. */
  | { refused: ApiError; reusable: boolean }
  /** Any other failure; retryable only when nothing was sent yet. */
  | { failed: true; beforeEgress: boolean };

/**
 * Begin the oauth2 flow of a hosted-connect session whose jti the caller spent; the caller renders
 * the outcome. An auto-provisioned client may have registered upstream before refusing (#1344).
 */
async function beginHostedOAuth(
  claims: ConnectSessionClaims,
  manifest: IntegrationManifestDef,
  auth: IntegrationAuthDef,
  variables?: Record<string, string>,
): Promise<HostedOAuthBegin> {
  const ctx = {
    scope: scopeFromClaims(claims),
    actor: actorFromClaims(claims),
    integrationId: claims.package_id,
    authKey: claims.auth_key,
  };
  const log = { packageId: claims.package_id, authKey: claims.auth_key };
  let scopes: string[];
  let begin: NonNullable<ReturnType<typeof resolveStrategy>["begin"]>;
  try {
    scopes = await connectScopes(ctx, auth, claims.scopes, claims.connection_id);
    const strategy = resolveStrategy(auth);
    if (!strategy.begin) throw new Error(`auth type '${auth.type}' has no begin`);
    begin = strategy.begin.bind(strategy);
  } catch (err) {
    logger.error("Hosted connect scope resolution failed", { err: String(err), ...log });
    return { failed: true, beforeEgress: true };
  }
  try {
    const result = await begin(
      {
        ...ctx,
        ...(claims.connection_id ? { connectionId: claims.connection_id } : {}),
        ...(claims.delegated ? { delegated: true } : {}),
        ...(variables ? { variables } : {}),
      },
      { scopes, forceAccountSelect: claims.force_account_select ?? false },
    );
    return { redirectUrl: result.redirectUrl };
  } catch (err) {
    if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
      // The detail names operator artefacts (#1345): logged, never rendered.
      logger.warn("Hosted connect OAuth begin refused", {
        status: err.status,
        code: err.code,
        detail: err.message,
        ...log,
      });
      return { refused: err, reusable: !usesAutoProvisionedClient(manifest, auth) };
    }
    logger.error("Hosted connect OAuth begin failed", { err: String(err), ...log });
    return { failed: true, beforeEgress: false };
  }
}

// ─────────────────────────────────────────────
// Router
// ─────────────────────────────────────────────

export function createIntegrationsRouter() {
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
    const scope = getSpaceScope(c);
    const fields = parseFieldSelection(c, INTEGRATION_FIELDS);
    const pagination = parseListPagination(c, { defaultLimit: 100 });
    const summaries = await listIntegrations(scope);
    // Decorate with `active` + `block_user_connections` flags for the current
    // space via the shared resolver — the single source of truth, also
    // used by the agent-editor detail endpoint, so the two surfaces can never
    // diverge (env-backed SYSTEM integrations stay active on both).
    const activations = await resolveIntegrationActivations(
      summaries.map((s) => s.id),
      scope.spaceId,
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

  // One handler for the shared `/callback` and the per-authorization-server
  // `/callback/:tag` of a server chosen per connection (AFPS §7.3): the state
  // names which of the two the response must arrive at, both ways.
  const oauthCallback = async (c: Context<AppEnv>, redirectTag: string | null) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    const error = c.req.query("error");
    if (error) {
      logger.warn("Integration OAuth callback received error", { error });
      // Authorization-endpoint failure (user denied, unregistered redirect URI,
      // unknown scope): the provider redirects back with `error` instead of
      // `code`. Normalized to a code-shaped token before display — the query
      // string is attacker-reachable, and a page that renders arbitrary text
      // from it is a phishing surface even when the text is HTML-escaped.
      const code = normalizeOAuthErrorCode(error);
      return c.html(
        popupHtmlError(
          code ? `OAuth error: ${code}` : "The provider refused the authorization request.",
          { state },
          3000,
        ),
      );
    }
    if (!code || !state) {
      return c.html(popupHtmlError("Missing required parameters", { state }, 3000));
    }
    let result: IntegrationOAuthCallbackResult;
    try {
      const iss = c.req.query("iss");
      result = await handleIntegrationOAuthCallback(
        oauthStateStore,
        resolveCallbackClient,
        code,
        state,
        undefined,
        { redirectTag, ...(iss !== undefined ? { iss } : {}) },
      );
    } catch (err) {
      if (err instanceof OAuthCallbackError) {
        // Append the provider's OAuth error code (never its free-text
        // description — see `oauth-error-diagnostic.ts`). Without it every
        // token-exchange failure reads identically, and the two an operator
        // can actually fix — a `redirect_uri` the provider does not know, a
        // rejected `token_endpoint_auth_method` — are invisible.
        const diagnostic = oauthDiagnosticSuffix(err.oauthError, err.status);
        const reason = {
          revoked:
            "The authorization expired before it could be exchanged. Please retry the connection.",
          client_unavailable:
            "The OAuth client this connection was started with is no longer available. Ask an administrator to check the integration's OAuth clients, then connect again.",
          client_rejected:
            "The provider rejected this integration's OAuth client. Ask an administrator to check the client's registration, then connect again.",
          transient: "Could not complete the connection. Please try again in a moment.",
          issuer_mismatch:
            "The authorization response did not come from the authorization server this connection was started with. Please retry the connection.",
        }[err.kind];
        const userMessage = `${reason}${diagnostic}`;
        logger.error("Integration OAuth callback failed", {
          subjectId: err.subjectId,
          kind: err.kind,
          status: err.status,
          oauthError: err.oauthError,
          oauthErrorDescription: err.oauthErrorDescription,
        });
        return c.html(popupHtmlError(userMessage, { state }));
      }
      // Not an `OAuthCallbackError`, so nothing authored this message for a
      // reader: it is a DB fault, a TypeError, an SSRF refusal. Same rule as
      // the branch above and as `/connect/start` (issue #1345) — this page is
      // session-less, so the text goes to the log and the user gets the
      // generic sentence.
      logger.error("Integration OAuth callback threw", { err: String(err) });
      return c.html(
        popupHtmlError("Could not complete the connection. Please try again.", { state }),
      );
    }

    // Persist via the OAuth2 strategy. The exchange above reconstructed the
    // actor/scope context from the signed state; the strategy does identity
    // extraction (token response + id_token + userinfo) + persist through the
    // single credential writer.
    try {
      const scope = { orgId: result.orgId, spaceId: result.spaceId };
      const { manifest, auth } = await readIntegrationAuth(scope, result.packageId, result.authKey);
      const strategy = resolveStrategy(auth);
      const ctx: ConnectContext = {
        scope,
        actor: result.actor,
        integrationId: result.packageId,
        authKey: result.authKey,
        ...(result.connectionId ? { connectionId: result.connectionId } : {}),
        ...(result.delegated ? { delegated: true } : {}),
        ...(result.variables ? { variables: result.variables } : {}),
      };
      const { audit } = await completeConnect(strategy, ctx, { kind: "oauth2-result", result });
      await recordAuditAs(
        c,
        { ...scope, actorType: result.actor.type, actorId: result.actor.id },
        audit,
      );
      logger.info("Integration OAuth callback success", {
        packageId: result.packageId,
        authKey: result.authKey,
        scopeShortfall: scopesNotCovered(
          result.scopesRequested,
          result.scopesGranted,
          manifest,
          result.authKey,
        ),
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
  };
  router.get("/callback", (c) => oauthCallback(c, null));
  router.get("/callback/:tag", (c) => oauthCallback(c, c.req.param("tag")));

  router.get("/:packageId{@[^/]+/[^/]+}", requirePermission("integrations", "read"), async (c) => {
    const packageId = c.req.param("packageId")!;
    const scope = getSpaceScope(c);
    const actor = getActor(c);
    await assertIsIntegration(scope, packageId);
    const status = await getIntegrationAuthStatuses(scope, packageId, actor, isUserPrincipal(c));
    return c.json(status);
  });

  // ─── OAuth client registration (admin) ─────

  // The space's OAuth clients plus the default it inherits (org or system); new
  // connections always use the default — there is no per-connect picker.
  // Deleting a client deletes the connections it minted.
  const clients = oauthClientHandlers(getSpaceScope, (c) => c.req.param("packageId")!);
  const configure = requirePermission("integrations", "configure");
  router.get(
    "/:packageId{@[^/]+/[^/]+}/auths/:authKey/clients",
    requirePermission("integrations", "read"),
    clients.list,
  );
  router.put(
    "/:packageId{@[^/]+/[^/]+}/auths/:authKey/default-client",
    configure,
    clients.setDefault,
  );
  router.post("/:packageId{@[^/]+/[^/]+}/auths/:authKey/oauth-clients", configure, clients.create);
  router.patch("/:packageId{@[^/]+/[^/]+}/oauth-clients/:clientId", configure, clients.update);
  router.delete("/:packageId{@[^/]+/[^/]+}/oauth-clients/:clientId", configure, clients.remove);

  // Move one of this space's clients to the org tier; its row id is kept, so
  // the connections it minted keep refreshing.
  router.post(
    "/:packageId{@[^/]+/[^/]+}/oauth-clients/:clientId/promote",
    configure,
    requirePermission("org-integrations", "configure"),
    async (c) => {
      const packageId = c.req.param("packageId")!;
      const clientId = assertOAuthClientRowId(c.req.param("clientId")!);
      const client = await promoteIntegrationOAuthClient(getSpaceScope(c), packageId, clientId);
      await recordAuditFromContext(c, {
        action: "integration.oauth_client.promoted",
        resourceType: "integration",
        resourceId: `${packageId}#${client.auth_key}#${clientId}`,
      });
      return c.json(toPublicClient(client));
    },
  );

  // ─── Connect flows ─────────────────────────

  // Porte B — import a connection (programmatic). The caller submits the
  // credential it already holds; the connection is created directly. No hosted
  // form, no end-user interaction. The interactive path is the Connect portal
  // (`connect/session`) — use that whenever a human/agent supplies the secret.
  //
  // No provisioner runs here, so a provisioned auth (`@appstrate/ssh`) never
  // connects through this door: a platform-minted name is refused below (see
  // `services/connect/provisioning.ts`), and omitting it fails `required`.
  // Runtime invariants therefore live in the auth's `credentials.schema`,
  // validated on both doors — not in the provisioner.
  router.post(
    "/:packageId{@[^/]+/[^/]+}/auths/:authKey/connect/fields",
    requirePermission("integrations", "connect"),
    async (c) => {
      const packageId = c.req.param("packageId")!;
      const authKey = c.req.param("authKey")!;
      const scope = getSpaceScope(c);
      const actor = getActor(c);
      const delegated = !isUserPrincipal(c);
      await assertConnectionCreationAllowed(c, scope.spaceId, packageId);
      const body = await readJsonBody(c, importConnectionSchema);
      // A reconnect target must be the caller's own connection in this space —
      // otherwise the credential write below would overwrite an arbitrary
      // (possibly another actor's) connection (IDOR).
      if (body.connection_id) {
        await assertConnectionBelongsToActor(body.connection_id, scope.spaceId, actor, delegated);
      }
      try {
        const { auth } = await readIntegrationAuth(scope, packageId, authKey);
        if (auth.type === "oauth2") {
          throw invalidRequest(
            `Auth '${authKey}' is type '${auth.type}' — use the OAuth flow, not the fields flow`,
          );
        }
        const minted = readProvisioning(packageId, authKey)?.provides.find(
          (name) => name in body.credentials,
        );
        if (minted) {
          throw invalidRequest(
            `\`${minted}\` is minted by the platform, not submitted — create this connection ` +
              "through the connect portal (`connect/session`)",
          );
        }
        // A `custom` + `connect.tool` (runAt:"link") auth resolves to the
        // OrchestratedStrategy, which needs the connect-run substrate to run
        // the untrusted login tool. Supply it lazily so the plain
        // paste-the-bag / declarative paths don't construct an executor.
        const ctx: ConnectContext = {
          scope,
          actor,
          integrationId: packageId,
          authKey,
          ...(body.connection_id ? { connectionId: body.connection_id } : {}),
          delegated,
          ...(body.variables ? { variables: body.variables } : {}),
        };
        const strategy = resolveStrategy(auth, { connectToolExecutor: createConnectRunExecutor() });
        const { conn, audit } = await completeConnect(strategy, ctx, {
          kind: "fields",
          credentials: body.credentials,
        });
        await recordAuditFromContext(c, audit);
        return c.json(conn);
      } catch (err) {
        if (err instanceof ApiError) throw err;
        logger.error("Integration fields connect failed", { err: String(err) });
        throw internalError();
      }
    },
  );

  // Rate-limited: each call may discover a server the caller chose and register a client there.
  router.post(
    "/:packageId{@[^/]+/[^/]+}/auths/:authKey/connect/oauth2",
    rateLimit(30),
    requirePermission("integrations", "connect"),
    async (c) => {
      const packageId = c.req.param("packageId")!;
      const authKey = c.req.param("authKey")!;
      const scope = getSpaceScope(c);
      const actor = getActor(c);
      const delegated = !isUserPrincipal(c);
      await assertConnectionCreationAllowed(c, scope.spaceId, packageId);
      const body = await readJsonBody(c, connectOAuthSchema, { allowEmpty: true });
      // Same reconnect-target IDOR guard as connect/fields: the connection_id is
      // carried into the OAuth state and honored at callback-time write.
      if (body.connection_id) {
        await assertConnectionBelongsToActor(body.connection_id, scope.spaceId, actor, delegated);
      }

      const { auth } = await readIntegrationAuth(scope, packageId, authKey);
      if (auth.type !== "oauth2") {
        throw invalidRequest(
          `Auth '${authKey}' is type '${auth.type}' — use the fields flow instead`,
        );
      }
      assertScopesInAuthCatalog(auth, authKey, body.scopes);
      // The kickoff deliberately does NOT walk the space's agents: scope upgrades are an explicit,
      // per-agent action. Endpoint validation + client lookup live in OAuth2Strategy.begin.
      const scopes = await connectScopes(
        { scope, actor, integrationId: packageId, authKey },
        auth,
        body.scopes,
        body.connection_id,
      );
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
          delegated,
          ...(body.variables ? { variables: body.variables } : {}),
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
      const scope = getSpaceScope(c);
      const actor = getActor(c);
      const delegated = !isUserPrincipal(c);
      await assertConnectionCreationAllowed(c, scope.spaceId, packageId);
      const body = await readJsonBody(c, connectSessionSchema, { allowEmpty: true });
      // Same reconnect-target IDOR guard as connect/fields: the connection_id is
      // minted into the hosted-connect capability token and honored at write.
      if (body.connection_id) {
        await assertConnectionBelongsToActor(body.connection_id, scope.spaceId, actor, delegated);
      }
      // Validate the auth exists (404/409 surfaced now, not after the redirect).
      const { auth } = await readIntegrationAuth(scope, packageId, authKey);
      // `scopes` are checked HERE, at the mint: `/connect/start` replays our own
      // signed claims, so it re-validates nothing.
      assertScopesInAuthCatalog(auth, authKey, body.scopes);
      const { connectUrl, expiresAt } = buildConnectUrl(
        connectClaimsFor({
          scope,
          actor,
          packageId,
          authKey,
          ...(body.connection_id ? { connectionId: body.connection_id } : {}),
          delegated,
          ...(body.scopes ? { scopes: body.scopes } : {}),
          ...(body.force_account_select ? { forceAccountSelect: true } : {}),
        }),
      );
      return c.json({ connect_url: connectUrl, expiresAt });
    },
  );

  // GET /connect/start?token=… — the single dispatch entry point. Verifies the
  // capability token, consumes its jti (single-use), pins a page cookie, then
  // redirects: oauth2 → provider screen; else → the hosted SPA form at /connect.
  //
  // Rate-limited per IP: no session, the signed token is the only credential,
  // and a refusal that hands the jti back leaves the link replayable for its
  // 10-minute TTL (issue #1344). The 429 is the platform's standard
  // problem+json, not a popup page: it answers abuse, not a flow failure.
  router.get("/connect/start", rateLimitByIp(60), async (c) => {
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
    // Every completion this handler emits must name the integration (issue
    // #1346): a completion identifying nothing matches every card by contract
    // (`completionMatches`), and `packageId` is the only identifier a
    // hosted-connect page holds — the OAuth `state` is minted later.
    const completionDetail = { packageId: claims.package_id };
    // Resolve the integration BEFORE consuming the jti — if the auth no longer
    // exists, the capability token stays unburned so the caller can retry once
    // the integration is back, rather than being forced to re-mint.
    let auth: IntegrationAuthDef;
    let manifest: IntegrationManifestDef;
    try {
      ({ auth, manifest } = await readIntegrationAuth(scope, claims.package_id, claims.auth_key));
    } catch {
      return c.html(
        popupHtmlError("This integration is no longer available.", completionDetail),
        410,
      );
    }
    // Single-use: burn the jti only once we know the link is actionable.
    if (!(await consumeJti(claims.jti, claims.exp))) {
      return c.html(
        popupHtmlError("This connect link has already been used.", completionDetail),
        410,
      );
    }

    // An integration declaring connection variables (AFPS §7.12) collects them on the hosted form
    // first: its oauth2 begins from `/connect/submit`, once the user has chosen the upstream.
    if (auth.type === "oauth2" && getVariablesSchema(manifest) === null) {
      const begun = await beginHostedOAuth(claims, manifest, auth);
      if ("redirectUrl" in begun) return c.redirect(begun.redirectUrl);
      if ("refused" in begun) {
        // Rendered generically, with the refusal's own status (#1263, #1345).
        if (begun.reusable) await releaseJti(claims.jti);
        const retry = begun.reusable ? "open this link again" : "request a new connection link";
        return c.html(
          popupHtmlError(
            `This integration is not ready to be connected. Ask an administrator to finish setting it up, then ${retry}.`,
            completionDetail,
          ),
          begun.refused.status as ContentfulStatusCode,
        );
      }
      // Nothing sent upstream yet: the very same link works once the fault passes (#1352).
      // Otherwise the flow may have gone half way, and the burn stops a replay re-entering it.
      if (begun.beforeEgress) await releaseJti(claims.jti);
      return c.html(
        popupHtmlError("Could not start the connection. Please try again.", completionDetail),
        begun.beforeEgress ? 500 : 502,
      );
    }

    // Non-oauth, or oauth2 with connection variables → hand off to the hosted
    // SPA form. Pin the page cookie so the form can read context via
    // GET /connect/context (no token in the URL). The oauth2 branch above never
    // reaches here, so the cookie is set only when the hosted form needs it.
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
    const variablesSchema = getVariablesSchema(manifest);
    // A reconnect shows the values the connection was made with; `connection_id` rides signed
    // claims minted after `assertConnectionBelongsToActor`.
    const values =
      variablesSchema && claims.connection_id
        ? await getIntegrationConnectionVariables(claims.connection_id)
        : null;
    return c.json({
      packageId: claims.package_id,
      auth_key: claims.auth_key,
      display_name: manifest.display_name ?? claims.package_id,
      icon: manifest.icon ?? null,
      auth: authWithoutMintedCredentials(claims.package_id, claims.auth_key, auth),
      connection_id: claims.connection_id ?? null,
      csrf: claims.csrf ?? null,
      variables: variablesSchema ? { schema: variablesSchema, values: values ?? {} } : null,
    });
  });

  // POST /connect/submit — hosted-form credential submit. Context + actor come
  // from the page cookie; the request carries only the credentials + CSRF nonce.
  // Rate-limited per IP like `/connect/start`: no session, and an oauth2 submit
  // reaches a server the submitter chose.
  router.post("/connect/submit", rateLimitByIp(20), async (c) => {
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
    try {
      const { manifest, auth } = await readIntegrationAuth(
        scope,
        claims.package_id,
        claims.auth_key,
      );
      if (auth.type === "oauth2") {
        if (body.credentials) {
          throw invalidRequest(
            "This integration uses OAuth: submit its connection variables only",
            "credentials",
          );
        }
        // The capability token's jti was burned by `/connect/start`; the page cookie's own jti
        // is spent here, so one link starts one authorization request.
        if (!(await consumeJti(claims.jti, claims.exp))) {
          throw notFound("No active connect session");
        }
        const begun = await beginHostedOAuth(claims, manifest, auth, body.variables);
        if ("redirectUrl" in begun) {
          clearConnectPageCookie(c);
          return c.json({ ok: true, redirect_url: begun.redirectUrl });
        }
        if ("refused" in begun && begun.refused.code === "validation_failed") {
          // A variable to fix, shown beside its field: the form may be submitted again.
          await releaseJti(claims.jti);
          throw begun.refused;
        }
        const reusable = "refused" in begun ? begun.reusable : begun.beforeEgress;
        if (reusable) await releaseJti(claims.jti);
        else clearConnectPageCookie(c);
        if ("refused" in begun) {
          throw new ApiError({
            status: begun.refused.status,
            code: "connection_not_ready",
            title: "Connection Not Ready",
            detail: `This integration is not ready to be connected. Ask an administrator to finish setting it up, then ${
              reusable ? "submit this form again" : "request a new connection link"
            }.`,
          });
        }
        if (begun.beforeEgress) throw internalError();
        throw new ApiError({
          status: 502,
          code: "connect_start_failed",
          title: "Bad Gateway",
          detail: "Could not start the connection. Please request a new connection link.",
        });
      }
      if (!body.credentials) {
        throw invalidRequest("credentials payload cannot be empty", "credentials");
      }
      const submittedCredentials = body.credentials;
      const provisioning = readProvisioning(claims.package_id, claims.auth_key);
      // On a reconnect, the stored bundle, so the provisioner can reuse the key
      // already installed on the target. Decrypted only for a provisioning
      // auth; safe because `connection_id` rides SIGNED claims minted after
      // `assertConnectionBelongsToActor` (`connect/session` above).
      const existing =
        provisioning && claims.connection_id
          ? await getIntegrationConnectionCredentialFields(claims.connection_id)
          : null;
      // Before `complete`, so minted values share the envelope and a
      // provisioning failure is a 400 on the form, not an unusable connection.
      const provisioned = await provisionCredentials(
        claims.package_id,
        claims.auth_key,
        submittedCredentials,
        existing,
      );
      const credentials = provisioned
        ? { ...submittedCredentials, ...provisioned }
        : submittedCredentials;

      const ctx: ConnectContext = {
        scope,
        actor,
        integrationId: claims.package_id,
        authKey: claims.auth_key,
        ...(claims.connection_id ? { connectionId: claims.connection_id } : {}),
        ...(claims.delegated ? { delegated: true } : {}),
        ...(body.variables ? { variables: body.variables } : {}),
      };
      const strategy = resolveStrategy(auth, { connectToolExecutor: createConnectRunExecutor() });
      const { conn, audit } = await completeConnect(strategy, ctx, { kind: "fields", credentials });
      await recordAuditAs(c, { ...scope, actorType: actor.type, actorId: actor.id }, audit);
      clearConnectPageCookie(c);
      // Carried on the response, not fetched: the page cookie that authenticates
      // the portal was just cleared, and the end-user may hold no session.
      return c.json({
        ok: true,
        connection: conn,
        ...(provisioning
          ? { handoff_steps: handoffStepsFor(claims.package_id, claims.auth_key, credentials) }
          : {}),
      });
    } catch (err) {
      if (err instanceof ApiError) throw err;
      logger.error("Hosted connect submit failed", { err: String(err) });
      throw internalError();
    }
  });

  router.get(
    "/:packageId{@[^/]+/[^/]+}/connections",
    requirePermission("integrations", "read"),
    async (c) => {
      const packageId = c.req.param("packageId")!;
      const scope = getSpaceScope(c);
      const actor = getActor(c);
      const items = await listIntegrationConnections(scope, packageId, actor, isUserPrincipal(c));
      return c.json(listResponse(items));
    },
  );

  // The per-integration agent-resolution verdict is now served in bulk by
  // GET /api/agents/:scope/:name/connection-readiness (one call per agent).

  // ─── Admin: block_user_connections + pins + connection metadata ──

  router.patch(
    "/:packageId{@[^/]+/[^/]+}/settings",
    requirePermission("integrations", "configure"),
    async (c) => {
      const packageId = c.req.param("packageId")!;
      const scope = getSpaceScope(c);
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
      const detail = await getIntegrationAuthStatuses(scope, packageId, actor, isUserPrincipal(c));
      return c.json(detail);
    },
  );

  router.get(
    "/:packageId{@[^/]+/[^/]+}/pins",
    requirePermission("integrations", "read"),
    async (c) => {
      const packageId = c.req.param("packageId")!;
      const scope = getSpaceScope(c);
      const items = await listIntegrationPins(scope, packageId);
      return c.json(listResponse(items));
    },
  );

  /**
   * R2 — the space's agents that declare this integration
   * in their dependencies. Drives the "pin a new agent" picker on the
   * integration detail page so admins can manage pins from one place.
   */
  router.get(
    "/:packageId{@[^/]+/[^/]+}/consuming-agents",
    requirePermission("integrations", "read"),
    async (c) => {
      const packageId = c.req.param("packageId")!;
      const scope = getSpaceScope(c);
      const items = await listAgentsConsumingIntegration(scope, packageId);
      return c.json(listResponse(items));
    },
  );

  router.put(
    "/:packageId{@[^/]+/[^/]+}/pins/:agentPackageId{@[^/]+/[^/]+}",
    requirePermission("integrations", "configure"),
    async (c) => {
      const packageId = c.req.param("packageId")!;
      const agentPackageId = c.req.param("agentPackageId")!;
      const scope = getSpaceScope(c);
      const body = await readJsonBody(c, setPinSchema);
      const userId = c.get("user")?.id ?? null;
      const { previous, pin } = await upsertIntegrationPin(scope, packageId, {
        agentPackageId,
        connectionIds: body.connection_ids,
        createdBy: userId,
      });
      await recordAuditFromContext(c, {
        action: "integration.pin.upserted",
        resourceType: "integration_pin",
        resourceId: pinAuditResourceId(agentPackageId, packageId),
        before: pinAudit(previous),
        after: pinAudit(pin.connection_ids),
      });
      return c.json(pin);
    },
  );

  router.delete(
    "/:packageId{@[^/]+/[^/]+}/pins/:agentPackageId{@[^/]+/[^/]+}",
    requirePermission("integrations", "configure"),
    async (c) => {
      const packageId = c.req.param("packageId")!;
      const agentPackageId = c.req.param("agentPackageId")!;
      const scope = getSpaceScope(c);
      const { previous } = await deletePin(scope, agentPackageId, packageId, null);
      if (previous) {
        await recordAuditFromContext(c, {
          action: "integration.pin.deleted",
          resourceType: "integration_pin",
          resourceId: pinAuditResourceId(agentPackageId, packageId),
          before: pinAudit(previous),
        });
      }
      // Idempotent delete — 204 whether the pin existed or not.
      return c.body(null, 204);
    },
  );

  // ─── Space default connection (cross-agent governance; `org_default` on the wire) ───
  // One default connection set per (space, integration) — the resolver
  // baseline for every consuming agent of the space (enforce → space-wide lock;
  // soft → overridable by member pins). Admin-only.

  router.get(
    "/:packageId{@[^/]+/[^/]+}/default",
    requirePermission("integrations", "read"),
    async (c) => {
      const packageId = c.req.param("packageId")!;
      const scope = getSpaceScope(c);
      const item = await getOrgDefault(scope, packageId);
      // Bare resource, or 204 when no default is set — same contract as
      // PUT (bare resource) and the models/proxies default endpoints (#657).
      if (!item) return c.body(null, 204);
      return c.json(item);
    },
  );

  router.put(
    "/:packageId{@[^/]+/[^/]+}/default",
    requirePermission("integrations", "configure"),
    async (c) => {
      const packageId = c.req.param("packageId")!;
      const scope = getSpaceScope(c);
      const body = await readJsonBody(c, setOrgDefaultSchema);
      const userId = c.get("user")?.id ?? null;
      const { previous, orgDefault } = await upsertOrgDefault(scope, packageId, {
        connectionIds: body.connection_ids,
        enforce: body.enforce,
        createdBy: userId,
      });
      await recordAuditFromContext(c, {
        action: "integration.org_default.upserted",
        resourceType: "integration_org_default",
        resourceId: packageId,
        before: orgDefaultAudit(previous),
        after: orgDefaultAudit(orgDefault),
      });
      return c.json(orgDefault);
    },
  );

  router.delete(
    "/:packageId{@[^/]+/[^/]+}/default",
    requirePermission("integrations", "configure"),
    async (c) => {
      const packageId = c.req.param("packageId")!;
      const scope = getSpaceScope(c);
      const { previous } = await deleteOrgDefault(scope, packageId);
      if (previous) {
        await recordAuditFromContext(c, {
          action: "integration.org_default.deleted",
          resourceType: "integration_org_default",
          resourceId: packageId,
          before: orgDefaultAudit(previous),
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
      // `connectionId` hits a `uuid` column — a non-UUID raises PG `22P02` and
      // surfaces as a 500. Validate first and collapse to the same `notFound`
      // the missing-row branch returns (no information leak / no 500).
      if (!z.uuid().safeParse(connectionId).success) {
        throw notFound(`Connection '${connectionId}' not found`);
      }
      const body = await readJsonBody(c, updateConnectionSchema);
      const { orgId, spaceId } = getSpaceScope(c);
      const viewer = {
        actor: getActor(c),
        spaceId,
        governs: canConfigureIntegrations(c),
        // A delegated credential acts from this space only.
        boundSpaceId: isUserPrincipal(c) ? null : spaceId,
      };
      return c.json(await applyConnectionUpdate(c, orgId, viewer, connectionId, body));
    },
  );

  return router;
}

/**
 * Does the caller govern this space's integrations?
 *
 * `integrations:configure` is deliberately absent from the API-key allowlist,
 * so an API key can never hold it however it was minted — which is what keeps
 * the space-wide governance mutations (settings gate, agent pins, org default)
 * session-only. Used for the in-handler branches; the routes that are wholly
 * governance mutations carry `requirePermission("integrations", "configure")`
 * as middleware instead.
 */
function canConfigureIntegrations(c: import("hono").Context<AppEnv>): boolean {
  return c.get("permissions")?.has("integrations:configure") ?? false;
}

/** Both connection-edit doors: apply, drop disabled schedules' jobs, audit, echo the row. */
export async function applyConnectionUpdate(
  c: Context<AppEnv>,
  orgId: string,
  viewer: Omit<ConnectionViewer, "permissionsIn">,
  connectionId: string,
  body: z.infer<typeof updateConnectionSchema>,
): Promise<IntegrationConnection> {
  const { connection, isOwner, added, removed, disabledScheduleIds } = await updateConnection({
    connectionId,
    viewer: {
      ...viewer,
      permissionsIn: (spaceId) => callerPermissionsInSpace(c, spaceId, orgId),
    },
    ...(body.label !== undefined ? { label: body.label } : {}),
    ...(body.shared_space_ids !== undefined ? { sharedSpaceIds: body.shared_space_ids } : {}),
  });
  await removeScheduleJobs(disabledScheduleIds);
  const audit = (action: string, after: AuditPayload, spaceIdOverride?: string) =>
    recordAuditFromContext(c, {
      action,
      resourceType: "integration_connection",
      resourceId: connectionId,
      after,
      // `/me/*` carries no org context: the audit names the connection's org.
      orgIdOverride: connection.orgId,
      ...(spaceIdOverride ? { spaceIdOverride } : {}),
    });
  // A share is recorded in the space it opens or closes.
  for (const spaceId of added) {
    await audit("integration.connection.share_added", { spaceId }, spaceId);
  }
  for (const spaceId of removed) {
    await audit("integration.connection.share_removed", { spaceId }, spaceId);
  }
  if (body.label !== undefined || disabledScheduleIds.length > 0) {
    await audit("integration.connection.metadata.updated", {
      ...(body.label !== undefined ? { label: body.label } : {}),
      ...(disabledScheduleIds.length > 0 ? { disabledScheduleIds } : {}),
    });
  }
  return serializeIntegrationConnection(connection, {
    owner: isOwner,
    within: isOwner ? viewer.boundSpaceId : viewer.spaceId,
  });
}
