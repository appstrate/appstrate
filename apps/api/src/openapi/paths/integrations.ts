// SPDX-License-Identifier: Apache-2.0

import { packageSourceValues } from "@appstrate/db/schema";
import { STD_RESPONSE_HEADERS } from "../headers.ts";
import { MAX_CONNECTIONS_PER_INTEGRATION } from "@appstrate/core/integration";
import { CONNECTION_LABEL_MAX } from "../../lib/connection-label.ts";

/**
 * OpenAPI paths for the AFPS integration marketplace.
 *
 * Endpoints are space-scoped — `X-Space-Id` is enforced by the
 * platform-level `requireSpaceContext()` middleware. The org-level OAuth
 * client routes (`paths/org-integrations.ts`) reuse the exported shapes.
 */

/** `GET /connect/start` answers every refusal with a rendered HTML page (`popupHtmlError`). */
const htmlErrorPage = { "text/html": { schema: { type: "string" } } } as const;

const oauthCallbackQueryParameters = [
  {
    name: "code",
    in: "query",
    required: false,
    schema: { type: "string" },
    description: "Authorization code returned by the IdP",
  },
  {
    name: "state",
    in: "query",
    required: false,
    schema: { type: "string" },
    description: "OAuth state parameter (UUID)",
  },
  {
    name: "error",
    in: "query",
    required: false,
    schema: { type: "string" },
    description: "OAuth error code (if the IdP rejected the request)",
  },
  {
    name: "iss",
    in: "query",
    required: false,
    schema: { type: "string" },
    description:
      "RFC 9207 issuer identifier of the authorization server that issued the response. Compared with the issuer the request was sent to whenever present.",
  },
] as const;

const oauthCallbackResponses = {
  "200": {
    description:
      "HTML page that closes the popup window. Renders either a success page or an error page (missing params, IdP error, response from another authorization server, code exchange failure, identity mismatch, or persistence failure).",
    headers: STD_RESPONSE_HEADERS,
  },
} as const;

const packageIdParam = {
  name: "packageId",
  in: "path",
  required: true,
  description: "Integration package id (e.g. `@official/gmail`).",
  schema: { type: "string", pattern: "^@[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9-]*$" },
} as const;

export const authKeyParam = {
  name: "authKey",
  in: "path",
  required: true,
  description: "Auth key as declared in the manifest's `auths` map.",
  schema: { type: "string", pattern: "^[a-z][a-z0-9_]*$" },
} as const;

const connectionIdParam = {
  name: "connectionId",
  in: "path",
  required: true,
  description: "Integration connection id (UUID).",
  schema: { type: "string", format: "uuid" },
} as const;

export const clientIdParam = {
  name: "clientId",
  in: "path",
  required: true,
  description: "Custom OAuth client id (`integration_oauth_clients.id`, UUID).",
  schema: { type: "string", format: "uuid" },
} as const;

export const agentPackageIdParam = {
  name: "agentPackageId",
  in: "path",
  required: true,
  description: "Agent package id (e.g. `@acme/my-agent`).",
  schema: { type: "string", pattern: "^@[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9-]*$" },
} as const;

/** The integration as the second package of a two-package path (member pins). */
export const integrationPackageIdParam = {
  ...packageIdParam,
  name: "integrationPackageId",
} as const;

/** A connection set as pins and launch overrides take and return it. */
export const connectionIdSetJsonSchema = {
  type: "array",
  items: { type: "string", format: "uuid" },
  minItems: 0,
  maxItems: MAX_CONNECTIONS_PER_INTEGRATION,
  uniqueItems: true,
  description:
    "A connection set. Absent (no pin, no key) defers to the next cascade layer; `[]` is explicit none: it wins its layer and the run starts without the integration. On an integration the agent marks `required`, `[]` is `required_integration_unbound`: a 400 `validation_failed` item (`field: connection_overrides.<id>`) on a launch override, a 409 item on the runs a `[]` pin governs.",
} as const;

/** The org default's set: never empty — none for every agent of the space is deactivation. */
const orgDefaultConnectionIdSetJsonSchema = {
  ...connectionIdSetJsonSchema,
  minItems: 1,
  description:
    "A connection set of 1 or more ids. An org default spans every agent of the space, so it cannot bind none: deactivating the integration in the space does that.",
} as const;

/** The refusals every connection-set write shares, beyond the per-connection checks. */
export const connectionSetRefusals = `more than ${MAX_CONNECTIONS_PER_INTEGRATION} ids, or a repeated id (compared case-insensitively)`;

/** {@link connectionSetRefusals} on an org-default write. */
const orgDefaultSetRefusals = `an empty set, ${connectionSetRefusals}`;

export const lockedBySchema = {
  type: ["string", "null"],
  enum: ["admin_pin", "org_default", null],
  description:
    "What binds this connection for every member of the space: `admin_pin` when an admin pin names it (takes precedence), `org_default` when an org default does; null when unlocked. While locked, unsharing or deleting it is refused with 409 `connection_pinned` until an admin removes it from the pin or default.",
} as const;

// The org default is keyed by (space, integration) ONLY — one set per
// integration, NOT one per (integration, auth_key): a set may mix auths, and
// PUT replaces it wholesale.
const integrationOrgDefaultSchema = {
  type: "object",
  required: ["integration_package_id", "connection_ids", "enforce", "createdAt", "updatedAt"],
  properties: {
    integration_package_id: { type: "string" },
    connection_ids: orgDefaultConnectionIdSetJsonSchema,
    enforce: { type: "boolean" },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
} as const;

const integrationSummarySchema = {
  type: "object",
  // Only `id` is guaranteed: this list supports the `?fields=` projection
  // (projectFields forces `id`, drops every other key on request).
  required: ["id"],
  properties: {
    id: { type: "string" },
    manifest: { type: "object", additionalProperties: true },
    orgId: { type: ["string", "null"] },
    source: { type: "string", enum: [...packageSourceValues] },
    active: { type: "boolean" },
    block_user_connections: { type: "boolean" },
  },
} as const;

/** Connection variables (AFPS §7.12): variable name → submitted string value. */
const connectionVariablesSchema = {
  type: "object",
  propertyNames: { type: "string", maxLength: 64 },
  additionalProperties: { type: "string", maxLength: 2048 },
  description:
    "Connection variables (AFPS §7.12): the non-secret values choosing this connection's upstream (e.g. a self-hosted instance URL), one per variable the integration declares in `variables.schema`. Required when the integration declares variables — also on a reconnect, which re-acquires the credential for the values submitted — and refused when it declares none. Each value is validated against the schema, must leave every URL template the auth uses renderable, and every rendered URL must pass the platform's egress controls; a refusal is a 400 `validation_failed` whose entries name `variables.<name>`.",
} as const;

// CASING: this connection wire shape mixes camelCase and snake_case by policy,
// not by oversight. `id`, `expiresAt`, `createdAt`, `updatedAt` are the
// universal DB-convention carve-outs (camelCase everywhere per
// docs/CASING_CONVENTIONS.md); every other field (`integration_package_id`, `auth_key`, `account_id`,
// `identity_claims`, `scopes_granted`, `needs_reconnection`, `owner_type`,
// `owner_id`, `shared_space_ids`, `client_ref`) is snake_case wire. Matches the
// serializer output (spec==runtime) — do NOT normalize either way.
export const connectionScopeSchema = {
  type: "string",
  enum: ["org", "space"],
  description:
    "Where the connection is usable, fixed by the OAuth client that minted it. `org`: minted by a system, org-tier or auto-provisioned client, or an API-key/basic/custom auth — usable from every space of the org that registers no manual OAuth client of its own for that auth (always from the space it was connected from). `space`: minted by a space's own OAuth client, or owned by an end user — it lives in that one space.",
} as const;

/** The projection every non-owner reads: the current space only, and only when shared into it. */
export const sharedSpaceIdsSchema = {
  type: "array",
  items: { type: "string" },
  description:
    "Spaces whose members may use the connection by an explicit pick. The owner's own session reads the full set on the lists and the edit; any other read — another member, a delegated credential, a connect response — reads `[<current space>]` when it is shared into the current space, else `[]`.",
} as const;

export const originSpaceIdSchema = {
  type: ["string", "null"],
  description:
    "The space an org-scoped connection was connected from — where it stays usable even if that space registers its own OAuth client. Projected as `shared_space_ids` is (outside the owner's own session, only when it is the current space); `null` otherwise, for a space-scoped connection, or once that space is deleted.",
} as const;

export const integrationConnectionSchema = {
  type: "object",
  required: [
    "id",
    "integration_package_id",
    "auth_key",
    "account_id",
    "identity_claims",
    "scopes_granted",
    "needs_reconnection",
    "expiresAt",
    "owner_type",
    "owner_id",
    "label",
    "scope",
    "shared_space_ids",
    "origin_space_id",
    "client_ref",
    "variables",
    "createdAt",
    "updatedAt",
  ],
  properties: {
    id: { type: "string", format: "uuid" },
    integration_package_id: { type: "string" },
    auth_key: { type: "string" },
    account_id: { type: "string" },
    identity_claims: { type: ["object", "null"], additionalProperties: true },
    scopes_granted: { type: "array", items: { type: "string" } },
    needs_reconnection: { type: "boolean" },
    expiresAt: { type: ["string", "null"], format: "date-time" },
    owner_type: { type: "string", enum: ["user", "end_user"] },
    owner_id: { type: "string" },
    owner_name: {
      type: ["string", "null"],
      description:
        "Display name of the connection's owner (member name, or end-user name falling back to its external id); null when the owner row was deleted. Returned by the list surfaces, which include connections other members share into the space; absent from the single-connection write responses, where the row is the caller's own.",
    },
    locked_by: {
      ...lockedBySchema,
      description: `${lockedBySchema.description} Returned by the list surfaces only, like \`owner_name\`: for the caller's own connection, a lock in any space (what its delete checks); for another's, a lock of the current space.`,
    },
    label: {
      type: "string",
      description:
        "User-given name. Always present — the column is NOT NULL, because a run binding several connections of one integration addresses each by its label.",
    },
    scope: connectionScopeSchema,
    shared_space_ids: sharedSpaceIdsSchema,
    origin_space_id: originSpaceIdSchema,
    client_ref: {
      type: ["string", "null"],
      description:
        "The registered OAuth client that minted this connection (system env id or custom `integration_oauth_clients.id`). Null for non-oauth2 auths. The connection is bound to it — changing it requires reconnecting.",
    },
    variables: {
      type: ["object", "null"],
      additionalProperties: { type: "string" },
      description:
        "The connection variables (AFPS §7.12) the connection's upstream was chosen with — non-secret and displayable (e.g. an instance URL). Null when the integration declares none. Changing them is a reconnect.",
    },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
} as const;

// Shared by GET .../clients and PUT .../default-client (space and org tiers) —
// both return the available-clients list so the UI re-badges the default in one
// round-trip.
export const integrationClientsListSchema = {
  type: "object",
  required: ["object", "data", "hasMore"],
  properties: {
    object: { type: "string", enum: ["list"] },
    hasMore: { type: "boolean" },
    data: {
      type: "array",
      items: {
        type: "object",
        required: [
          "client_ref",
          "source",
          "client_id",
          "is_default",
          "auto_provisioned",
          "has_client_secret",
          "token_endpoint_auth_method",
          "redirect_uri",
        ],
        properties: {
          client_ref: { type: "string" },
          source: {
            type: "string",
            enum: ["system", "org", "space"],
            description:
              "The tier that owns the client: `space` = the space's own client, `org` = an org-level client, `system` = a platform-provided system client.",
          },
          client_id: {
            type: "string",
            description:
              "For `space` / `org` clients, the registered OAuth client_id. For `system` clients, an opaque `sys_`-prefixed fingerprint (truncated SHA-256) — never the real system client_id, which is a deployment secret. Display-only; the connect/refresh keyspace is `client_ref`.",
          },
          is_default: {
            type: "boolean",
            description:
              "True for the client that mints new connections at the listed tier. Every listed client is a valid `client_ref` for PUT .../default-client.",
          },
          auto_provisioned: { type: "boolean" },
          has_client_secret: { type: "boolean" },
          token_endpoint_auth_method: {
            type: ["string", "null"],
            enum: ["client_secret_post", "client_secret_basic", "none", null],
            description:
              "Method declared for this client, overriding the manifest's. `none` = PUBLIC client (no secret at the provider). `null` = undeclared.",
          },
          redirect_uri: { type: ["string", "null"] },
        },
      },
    },
  },
} as const;

export const oauthClientSchema = {
  type: "object",
  required: [
    "id",
    "spaceId",
    "integration_package_id",
    "auth_key",
    "client_id",
    "has_client_secret",
    "token_endpoint_auth_method",
    "redirect_uri",
    "createdAt",
    "updatedAt",
  ],
  properties: {
    id: {
      type: "string",
      format: "uuid",
      description:
        "Row UUID — the `client_ref` handle passed to the update / delete / default-client routes.",
    },
    spaceId: {
      type: ["string", "null"],
      description: "Owning space; `null` for an org-level client, inherited by every space.",
    },
    integration_package_id: { type: "string" },
    auth_key: { type: "string" },
    client_id: { type: "string" },
    has_client_secret: { type: "boolean" },
    token_endpoint_auth_method: {
      type: ["string", "null"],
      enum: ["client_secret_post", "client_secret_basic", "none", null],
      description:
        "Client-authentication method declared for THIS client, overriding the integration manifest's. `none` means a PUBLIC client: the app is registered at the provider without a secret and authenticates by `client_id` alone. `null` means undeclared — the manifest's value applies.",
    },
    redirect_uri: { type: ["string", "null"] },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
} as const;

export const oauthClientCreateBodySchema = {
  type: "object",
  required: ["client_id"],
  properties: {
    client_id: { type: "string", minLength: 1 },
    client_secret: {
      type: "string",
      minLength: 1,
      description:
        "REQUIRED unless `token_endpoint_auth_method` is `none`. A public client is declared, never inferred: omitting the secret under any other method is rejected with 400 rather than silently registering a public client.",
    },
    token_endpoint_auth_method: {
      type: "string",
      enum: ["client_secret_post", "client_secret_basic", "none"],
      description:
        "Explicit client-authentication method for this client, overriding the manifest's. Send `none` to register a PUBLIC client (no secret at the provider), and then send no `client_secret`. Omit to leave it undeclared, in which case the manifest's value applies — and a `client_secret` is then mandatory.",
    },
    redirect_uri: { type: "string", format: "uri" },
  },
  additionalProperties: false,
} as const;

export const oauthClientUpdateBodySchema = {
  type: "object",
  description:
    "Merge semantics (RFC 7396): an absent field is left unchanged. `client_secret` and `token_endpoint_auth_method` are written together: sending neither keeps both. There is no `client_id`: the connections a client minted refresh only with the `client_id` their tokens were issued to, so a new `client_id` is a new client — register it, make it the default, then delete this one.",
  properties: {
    client_secret: {
      type: "string",
      description:
        "OMIT to preserve the stored secret. An empty string CLEARS it and is accepted only together with `token_endpoint_auth_method: none`; alone it is rejected with 400.",
    },
    token_endpoint_auth_method: {
      type: "string",
      enum: ["client_secret_post", "client_secret_basic", "none"],
      description:
        "Explicit client-authentication method for this client, overriding the manifest's. Send `none` to declare a PUBLIC client (no secret at the provider). Omitted beside a new `client_secret`, the stored method is kept — except a public client's `none`, which gives way to the manifest's value; sent alone, it changes the method of the stored secret.",
    },
    redirect_uri: {
      type: ["string", "null"],
      format: "uri",
      description:
        "Omit to keep the stored value; `null` clears it (the platform callback applies).",
    },
  },
  additionalProperties: false,
} as const;

export const setDefaultClientBodySchema = {
  type: "object",
  required: ["client_ref"],
  properties: {
    client_ref: {
      type: "string",
      description: "Client to make default — a `client_ref` from GET .../clients.",
    },
  },
  additionalProperties: false,
} as const;

const authStatusSchema = {
  type: "object",
  required: [
    "auth_key",
    "type",
    "required",
    "scopes",
    "resource",
    "connections",
    "ready",
    "has_oauth_client",
    "has_system_client",
    "client_auto_provisioned",
  ],
  properties: {
    auth_key: { type: "string" },
    type: {
      type: "string",
      enum: ["oauth2", "api_key", "basic", "mtls", "custom"],
      description:
        "Auth method type (AFPS §7.2). For `mtls`, client cert + key are supplied via `credentials.schema` and injected at runtime through `delivery.files`.",
    },
    required: {
      type: "boolean",
      description:
        "The auth's `_meta[\"dev.appstrate/auth\"].required` (absent = false): whether the integration cannot serve a run without a credential on this auth. Unrelated to an agent's `integrations_configuration.<id>.required`.",
    },
    scopes: { type: "array", items: { type: "string" } },
    resource: {
      type: ["string", "null"],
      description:
        "RFC 8707 resource indicator declared by the manifest (`auths.{key}.resource`). AFPS §7.3 name — matches the RFC.",
    },
    connections: { type: "array", items: integrationConnectionSchema },
    ready: {
      type: "boolean",
      description:
        "Server-authoritative usability: true when ≥1 connection here is not flagged for reconnection. Single source so clients never re-derive connection state. Agent-agnostic — a run's authoritative readiness still comes from validateInlineRun.",
    },
    has_oauth_client: {
      type: "boolean",
      description:
        "True when a custom OAuth client is registered for this auth, in this space or at the org level (inherited).",
    },
    has_system_client: {
      type: "boolean",
      description:
        "True when the platform provides a shared system OAuth client for this auth via `SYSTEM_INTEGRATIONS`. Connect falls back to it when neither the space nor the org has flagged a default client of its own, so the auth is connectable without a pre-registered client.",
    },
    client_auto_provisioned: {
      type: "boolean",
      description:
        'True for an oauth2 auth on a remote MCP integration (`source.kind: "remote"`). Per the MCP Authorization spec the OAuth client is provisioned automatically at connect time — discovery of the authorization server (RFC 9728 → RFC 8414) plus client acquisition without manual pre-registration (CIMD when advertised, else RFC 7591 dynamic registration) — so no pre-registered client is required.',
    },
  },
} as const;

const toolCatalogEntrySchema = {
  type: "object",
  required: ["name"],
  properties: {
    name: { type: "string" },
    description: { type: "string" },
    policy: {
      type: "object",
      properties: {
        required_scopes: {
          type: "object",
          additionalProperties: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
} as const;

const integrationDetailSchema = {
  type: "object",
  required: [
    "manifest",
    "auths",
    "tool_catalog",
    "allow_undeclared_tools",
    "active",
    "block_user_connections",
    "platform_redirect_uri",
  ],
  properties: {
    manifest: { type: "object", additionalProperties: true },
    auths: { type: "array", items: authStatusSchema },
    // Effective agent-facing tool catalog. Resolved server-side from the
    // referenced mcp-server's MCPB `tools[]` (local source) minus
    // `hidden_tools` and auto-hidden connect.tool primitives. Falls back
    // to `manifest.tools_policy` keys when the mcp-server is absent.
    tool_catalog: { type: "array", items: toolCatalogEntrySchema },
    // AFPS §4.4 — the tool(s) an agent inherits when it declares this
    // integration without an `integrations_configuration.<id>.tools`
    // selection. Pairs with `tool_catalog` so a builder sees what is on by
    // default vs what must be selected explicitly. Absent when the
    // integration declares no default. Resolution: omitted → inherits this;
    // `[]` → none; `[..]` → exactly those; `"*"` → all upstream tools.
    default_tools: {
      oneOf: [
        { type: "array", items: { type: "string" } },
        { type: "string", enum: ["*"] },
      ],
    },
    // AFPS §7.8 — opt-in surfaced verbatim from the manifest. When `true`,
    // the agent editor MAY offer the "all upstream tools" toggle that sets
    // `integrations_configuration.<id>.tools = "*"`. Default `false`.
    allow_undeclared_tools: { type: "boolean" },
    // Activation state in the current space — resource state shared
    // with the list endpoint, returned by every detail-shaped response
    // (GET detail, PATCH settings).
    active: { type: "boolean" },
    // Admin gate (`block_user_connections`): when `true`, only org admins
    // may create personal connections. `false` when not activated.
    block_user_connections: { type: "boolean" },
    // The platform's own OAuth callback — what connect sends when the resolved
    // client declares no `redirect_uri` override of its own. Same helper the
    // connect strategy uses, so this value cannot drift from the sent one; a
    // consumer showing "the URI to register at the provider" must still prefer
    // the default client's override when it has one.
    platform_redirect_uri: { type: "string", format: "uri" },
  },
} as const;

/**
 * The `503`/`504` pair every connect-run-backed connect operation answers with
 * (the programmatic `connectIntegrationFields` and the hosted form's
 * `submitConnectPage`). Spread at both sites so the two cannot drift: they
 * describe the SAME two failures of the SAME machinery — an execution backend
 * that cannot run a sidecar-only workload, and a login that never completed —
 * down to the `example` bodies a client codegens against.
 *
 * Module-local const, NOT a `#/components/responses/*` $ref: the spread is
 * inlined at serialization time, so the emitted spec stays byte-identical to
 * the hand-written pair it replaces. Same technique as `paths/files.ts`'s
 * `pipelineResponses`.
 */
/**
 * The two fields a caller relays verbatim from a readiness `integrations.<id>`
 * error onto either connect kickoff (`connect/oauth2`, `connect/session`).
 * Declared once so both surfaces document the relay identically.
 */
const connectKickoffRelayProperties = {
  scopes: {
    type: "array",
    items: { type: "string" },
    description:
      "OAuth scopes to request on top of the auth's `default_scopes` and whatever the target connection already holds. Forward `required_scopes` from a readiness `integrations.<id>` error verbatim. Each value must belong to the auth's `scope_catalog` when one is declared (400 `scope_not_in_catalog` otherwise).",
  },
  connection_id: {
    type: "string",
    format: "uuid",
    description:
      "Reconnect/upgrade this existing connection in place instead of creating a new one — the `connection_id` of the readiness error.",
  },
} as const;

const connectRunResponses = {
  "503": {
    description:
      "The configured execution backend cannot run a connect-run (sidecar-only workload). Operator configuration; the remedy is logged server-side and deliberately kept out of this response, which an end user can reach.",
    content: {
      "application/problem+json": {
        schema: { $ref: "#/components/schemas/ProblemDetail" },
        example: {
          type: "https://docs.appstrate.dev/errors/connect-unavailable",
          title: "Service Unavailable",
          status: 503,
          detail:
            "This connection method is unavailable on this deployment. Contact your administrator.",
          code: "connect_unavailable",
          request_id: "req_abc123",
        },
      },
    },
  },
  "504": {
    description:
      "The login did not complete within its timeout (`timeout`): a connect-run, or the request of a declarative `connect.login`.",
    content: {
      "application/problem+json": {
        schema: { $ref: "#/components/schemas/ProblemDetail" },
        example: {
          type: "https://docs.appstrate.dev/errors/timeout",
          title: "Gateway Timeout",
          status: 504,
          detail:
            "The connection attempt timed out after 60000ms — the login did not complete in time. Please try again.",
          code: "timeout",
          request_id: "req_def456",
        },
      },
    },
  },
} as const;

/** How a declarative `connect.login` (AFPS §7.7) refuses, on both connect surfaces. */
const CONNECT_LOGIN_400 =
  "A login the service refused is `invalid_request` on `credentials`, its `detail` starting `Login failed:`. A credential value the declarative login request cannot carry where it is placed, or a submitted base URL it may not reach, is `invalid_request` on `credentials.<field>`. Neither echoes a credential value nor the service's answer.";
const CONNECT_LOGIN_502 =
  "A declarative login (`connect.login`) could not complete: the service could not be reached, or answered 429 or 5xx (`bad_gateway`).";
const problemJson = {
  "application/problem+json": { schema: { $ref: "#/components/schemas/ProblemDetail" } },
} as const;

/** Shared by both connection-edit doors: this one and `PATCH /api/me/connections/{connectionId}`. */
export const connectionUpdateDescription =
  "The owner may rename the connection and set the WHOLE set of spaces it is shared into " +
  "(`shared_space_ids` replaces it): sharing is the owner's consent. A governor (`integrations:configure` " +
  "in the space the request is made from) may rename a space-scoped connection of that space, and withdraw " +
  "any connection from that space by sending the projection it reads without it (`[]`); nothing else. " +
  "A connection may be shared into a space of its org it serves: an org-scoped one into any space but one " +
  "with its own OAuth client for the integration (unless connected from there), a space-scoped one only into " +
  "its own space. Every target space must still be reached by the owning member, and one that blocks user " +
  "connections for the integration takes a sharer holding `integrations:configure` there (403 " +
  "`connection_blocked_by_admin`). A credential bound to a space (an API key, a space-bound token) adds or " +
  "removes that space only, and renames only a connection scoped to it. Sharing an end user's connection " +
  "is refused with 409 `end_user_connection_not_shareable`. Removing a space is refused with 409 " +
  "`connection_pinned` while an admin pin or an org default of THAT space names the connection. A member pin " +
  "does not block it: that member's next run fails with `pinned_connection_unavailable` until they pick " +
  "again. Removing a space disables, in the same transaction, every enabled schedule of that space of " +
  "another actor than the owner whose `connection_overrides` name the connection " +
  "(`disabled_reason: connection_unshared`, jobs removed), its overrides kept: while the connection stays " +
  "unreachable, re-enabling it requires a new choice. The owner's own schedules are untouched. A label is " +
  "unique per owner among the connections of the integration sharing its scope, compared verbatim: renaming " +
  "to one another holds is refused with 409 `connection_label_taken`. Each space added or removed is " +
  "audited on its own (`integration.connection.share_added` / `share_removed`).";

export const connectionUpdateRequestBody = {
  required: true,
  content: {
    "application/json": {
      schema: {
        type: "object",
        minProperties: 1,
        properties: {
          label: {
            type: "string",
            minLength: 1,
            maxLength: CONNECTION_LABEL_MAX,
            description:
              "A rename; the label cannot be cleared. It reaches the agent's model verbatim, so a whitespace-only label, one starting or ending with whitespace, or one holding a control character (line breaks and tabs included), a zero-width/invisible character or a bidirectional-override character is refused with 400, and one another connection of the same owner holds with 409 `connection_label_taken`.",
          },
          shared_space_ids: {
            type: "array",
            items: { type: "string", minLength: 1, maxLength: 100 },
            maxItems: 100,
            uniqueItems: true,
            description:
              "The WHOLE set of spaces whose members may bind this connection by an explicit pick; this write replaces it. `[]` shares it nowhere.",
          },
        },
        additionalProperties: false,
      },
    },
  },
} as const;

export const connectionUpdateRefusals400 =
  "Refused: no field, a malformed label, a repeated space id (`validation_failed`), or an added target that is not (or no longer) a space of the connection's org, or one it does not serve — another space than its own for a space-scoped connection, a space with its own OAuth client for an org-scoped one (`invalid_share_target`).";

export const connectionUpdateConflicts = {
  description:
    "Removing a space whose admin pin or org default names the connection (`connection_pinned`), renaming it to a label another connection of the same owner holds (`connection_label_taken`), sharing an end user's connection (`end_user_connection_not_shareable`), or sharing it into a space its owning member does not reach — removed concurrently, or the space closed (`connection_owner_without_access`)",
  headers: STD_RESPONSE_HEADERS,
  content: {
    "application/problem+json": {
      schema: { $ref: "#/components/schemas/ProblemDetail" },
    },
  },
} as const;

export const integrationsPaths = {
  "/api/integrations": {
    get: {
      operationId: "listIntegrations",
      tags: ["Integrations"],
      summary: "List available integrations",
      description:
        "List every AFPS integration PLACED in the current space — homed there, offered there, or shipped with the deployment — enriched with `active` + `block_user_connections` flags for that same space. Placement, not activation: an offer the space has not taken up and an integration switched off are both listed, with `active: false`. An integration homed in another space of the organization and offered to nobody is NOT listed, whatever the caller's organization role: the home is the only authority there is, and a personal space is read by nobody else (RBAC spec §3.6). Supports offset pagination (`limit`/`offset`) and a `fields` projection selector — request `?fields=id,source` to drop the heavy per-row `manifest` and fetch only what you need.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        {
          name: "limit",
          in: "query",
          schema: { type: "integer", minimum: 1, maximum: 100, default: 100 },
        },
        { $ref: "#/components/parameters/Offset" },
        {
          name: "fields",
          in: "query",
          description:
            "Comma-separated allowlist of fields to return per item (`id` is always included). Allowed: id, manifest, orgId, source, active, block_user_connections. An unknown field is a 400.",
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": {
          description: "Integration list",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["object", "data", "total", "hasMore"],
                properties: {
                  object: { type: "string", enum: ["list"] },
                  data: { type: "array", items: integrationSummarySchema },
                  total: { type: "integer" },
                  hasMore: { type: "boolean" },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
  },
  "/api/integrations/callback": {
    get: {
      operationId: "integrationsOAuthCallback",
      tags: ["Integrations"],
      summary: "Integration OAuth2 callback (popup)",
      description:
        "Browser-side OAuth callback for an authorization server fixed by the manifest. Exchanges code + state for tokens, persists the connection, and returns an HTML page that closes the popup window. A response for a flow started with an authorization server chosen per connection is refused here: it must arrive at that server's own `/callback/{tag}`. When the response carries `iss` (RFC 9207) it must name the authorization server the request was sent to, and a response without it is refused from a server that advertises `authorization_response_iss_parameter_supported`.",
      parameters: oauthCallbackQueryParameters,
      responses: oauthCallbackResponses,
    },
  },
  "/api/integrations/callback/{tag}": {
    get: {
      operationId: "integrationsOAuthCallbackForServer",
      tags: ["Integrations"],
      summary:
        "Integration OAuth2 callback of an authorization server chosen per connection (popup)",
      description:
        "The redirect URI registered with, and sent to, an authorization server chosen per connection (AFPS §7.3: an oauth2 auth whose `issuer` or `source.remote.url` is a URL template over connection variables). One per server — the RFC 9700 §4.4 mix-up defence — so the response must arrive at the tag of the server the request was sent to: a mismatch is refused, as is a response for a fixed server. Otherwise identical to `integrationsOAuthCallback`, including the RFC 9207 `iss` check.",
      parameters: [
        {
          name: "tag",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^[A-Za-z0-9_-]{22}$" },
          description:
            "The authorization server's tag: the first 22 characters of base64url(SHA-256(issuer)), the issuer of its validated RFC 8414 metadata.",
        },
        ...oauthCallbackQueryParameters,
      ],
      responses: oauthCallbackResponses,
    },
  },
  "/api/integrations/{packageId}": {
    get: {
      operationId: "getIntegration",
      tags: ["Integrations"],
      summary: "Get integration detail + per-auth status",
      description:
        "Detail of one integration, read FROM the current space: the integration must be PLACED there — homed there, offered there, or shipped with the deployment. An integration homed elsewhere and offered to nobody answers 404, whatever the caller's organization role (RBAC spec §3.6), exactly as `GET /api/packages/integrations/{packageId}` does for the same row. Being placed is not being active: the response carries `active` for the current space.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        packageIdParam,
      ],
      responses: {
        "200": {
          description: "Integration detail",
          headers: STD_RESPONSE_HEADERS,
          content: { "application/json": { schema: integrationDetailSchema } },
        },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": {
          description: "Wrong package type",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
      },
    },
  },
  "/api/integrations/{packageId}/auths/{authKey}/oauth-clients": {
    post: {
      operationId: "createIntegrationOAuthClient",
      tags: ["Integrations"],
      summary: "Register a custom OAuth client for an integration auth",
      description:
        "Registers a NEW custom (BYO-app) client for this auth, in this space — " +
        "it overrides the org-level clients here. Repeatable — a " +
        "space may hold N clients per auth (model-provider pattern). The first " +
        "registered client becomes the default; later ones are non-default until " +
        "promoted via PUT .../default-client. Rejected for auto-provisioned " +
        "(DCR/CIMD) auths. Requires `integrations:configure`, which is never granted to an API key.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        packageIdParam,
        authKeyParam,
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: oauthClientCreateBodySchema,
          },
        },
      },
      responses: {
        "201": {
          description: "Created",
          headers: STD_RESPONSE_HEADERS,
          content: { "application/json": { schema: oauthClientSchema } },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/integrations/{packageId}/oauth-clients/{clientId}": {
    patch: {
      operationId: "updateIntegrationOAuthClient",
      tags: ["Integrations"],
      summary:
        "Update a custom OAuth client (rotate its secret, change its redirect URI or method)",
      description:
        "Updates one of this space's custom clients in place, by its id (an " +
        "org-level client id is a 404 here). Its `client_id` cannot change. Auto-provisioned " +
        "(DCR/CIMD) clients are machine-managed and rejected. Requires `integrations:configure`, which is never granted to an API key.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        packageIdParam,
        clientIdParam,
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: oauthClientUpdateBodySchema,
          },
        },
      },
      responses: {
        "200": {
          description: "Updated",
          headers: STD_RESPONSE_HEADERS,
          content: { "application/json": { schema: oauthClientSchema } },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    delete: {
      operationId: "deleteIntegrationOAuthClient",
      tags: ["Integrations"],
      summary: "Delete a custom OAuth client",
      description:
        "Deletes one of this space's custom clients by id (an org-level client " +
        "id is a 404 here), with the connections it minted. If it was the " +
        "default, the cascade re-resolves (org default, else system client) " +
        "with no auto-promotion. Refused with 409 `connection_pinned` while an admin pin or an org default " +
        "(enforced or soft) names one of the connections it minted; a member pin does not block it. " +
        "Each deleted connection is dropped from its owner's member pins (a pin left empty is removed) " +
        "and from its owner's schedules' `connection_overrides` (a schedule whose set for an integration " +
        "is left empty is disabled); another member's pin keeps the id, and that member's next run fails " +
        "with `pinned_connection_unavailable`. Another actor's enabled schedules naming a deleted " +
        "connection are disabled (`disabled_reason: connection_deleted`), their overrides kept. " +
        "Requires `integrations:configure`, which is never granted to an API key.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        packageIdParam,
        clientIdParam,
      ],
      responses: {
        "204": {
          description: "OAuth client deleted",
          headers: STD_RESPONSE_HEADERS,
        },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": {
          description: "A connection the client minted is named by an admin pin or an org default",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
      },
    },
  },
  "/api/integrations/{packageId}/oauth-clients/{clientId}/promote": {
    post: {
      operationId: "promoteIntegrationOAuthClient",
      tags: ["Integrations"],
      summary: "Promote a space OAuth client to the org level",
      description:
        "Moves one of this space's custom clients to the org level (`spaceId: " +
        "null`), inherited by every space of the org. It keeps its id and secret, " +
        "so the connections it minted keep working; it becomes the org default " +
        "when the org has none. A space's auto-provisioned (DCR/CIMD) client moves too, " +
        "unless the org already holds the auto-provisioned client of the same authorization " +
        "server (409 `auto_client_exists_at_org`). Requires both `integrations:configure` and " +
        "`org-integrations:configure`, which are never granted to an API key.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        packageIdParam,
        clientIdParam,
      ],
      responses: {
        "200": {
          description: "Promoted; the client, now org-level",
          headers: STD_RESPONSE_HEADERS,
          content: { "application/json": { schema: oauthClientSchema } },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": {
          description:
            "`auto_client_exists_at_org`: the client is auto-provisioned and the org already holds the auto-provisioned client of its authorization server",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
      },
    },
  },
  "/api/integrations/{packageId}/auths/{authKey}/clients": {
    get: {
      operationId: "listIntegrationClients",
      tags: ["Integrations"],
      summary: "List the OAuth clients registered for an integration auth",
      description:
        "Returns this space's own custom (BYO-app) clients (`space`, oldest " +
        "first) plus the ONE default it inherits — the org default (`org`), else " +
        "the system client (`system`) — when that is not one of its own. Other " +
        "org and system clients are not listed: a space either uses its own " +
        "clients or inherits the org's choice. `is_default` marks the client new " +
        "connections use (no per-connect picker). Secrets are never returned. " +
        "Org-level clients are managed on `/api/org-integrations`.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        packageIdParam,
        authKeyParam,
      ],
      responses: {
        "200": {
          description: "Available OAuth clients",
          headers: STD_RESPONSE_HEADERS,
          content: { "application/json": { schema: integrationClientsListSchema } },
        },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/integrations/{packageId}/auths/{authKey}/default-client": {
    put: {
      operationId: "setDefaultIntegrationClient",
      tags: ["Integrations"],
      summary: "Set the default OAuth client for an integration auth",
      description:
        "Choose which client mints NEW connections when none is picked explicitly " +
        "(the model-provider `setDefaultModel` analogue). Selecting one of the " +
        "space's own clients flags it default; selecting the default the space " +
        "inherits (the org default, else the system client) un-flags the space's " +
        "clients so the space inherits it again. Any other `client_ref` is a 400. " +
        "Existing connections are bound " +
        "to the client that minted them and are unaffected. Returns the refreshed " +
        "clients list. Requires `integrations:configure`, which is never granted to an API key.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        packageIdParam,
        authKeyParam,
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: setDefaultClientBodySchema,
          },
        },
      },
      responses: {
        "200": {
          description: "Default set; available OAuth clients (re-badged)",
          headers: STD_RESPONSE_HEADERS,
          content: { "application/json": { schema: integrationClientsListSchema } },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/integrations/{packageId}/auths/{authKey}/connect/fields": {
    post: {
      operationId: "importIntegrationConnection",
      tags: ["Integrations"],
      summary: "Import a connection by submitting credentials directly (programmatic)",
      description:
        "Porte B (programmatic/headless): the backend already holds the credential and submits it directly to create the connection — the server-to-server analogue of the hosted Connect portal. Use for api_key / basic / custom auths. For OAuth2 auths use the headless OAuth start (`initiateIntegrationOAuth`); for interactive/human flows where the secret should never transit the caller, use the hosted Connect portal (`initiateIntegrationConnect`).\n\nA credential the platform mints (the `private_key` of `@appstrate/ssh`) is refused with a 400 naming the field; such an auth connects through the Connect portal (`initiateIntegrationConnect`).",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        packageIdParam,
        authKeyParam,
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["credentials"],
              properties: {
                credentials: {
                  type: "object",
                  additionalProperties: true,
                },
                connection_id: {
                  type: "string",
                  format: "uuid",
                  description:
                    "Existing connection to renew in place (api_key/PAT/custom). Omit on a fresh connect — the write then INSERTs a new row.",
                },
                variables: connectionVariablesSchema,
              },
              additionalProperties: false,
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Connection stored",
          headers: STD_RESPONSE_HEADERS,
          content: { "application/json": { schema: integrationConnectionSchema } },
        },
        "400": {
          $ref: "#/components/responses/ValidationError",
          description: `Invalid body or credentials. ${CONNECT_LOGIN_400}`,
        },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "502": { description: CONNECT_LOGIN_502, content: problemJson },
        ...connectRunResponses,
      },
    },
  },
  "/api/integrations/{packageId}/auths/{authKey}/connect/oauth2": {
    post: {
      operationId: "initiateIntegrationOAuth",
      tags: ["Integrations"],
      summary: "Headless OAuth2 PKCE start — returns an authorize URL (programmatic)",
      description:
        "Porte B (programmatic/headless): returns an `auth_url` the caller redirects the user to itself, then handles completion via the shared `/callback`. For an interactive, platform-hosted flow that also covers non-OAuth auths and keeps the secret off the caller, mint a hosted Connect portal session (`initiateIntegrationConnect`) instead.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        packageIdParam,
        authKeyParam,
      ],
      requestBody: {
        required: false,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                scopes: connectKickoffRelayProperties.scopes,
                force_account_select: { type: "boolean" },
                connection_id: connectKickoffRelayProperties.connection_id,
                variables: connectionVariablesSchema,
              },
              additionalProperties: false,
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Authorize URL",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["auth_url", "state"],
                properties: {
                  auth_url: { type: "string", format: "uri" },
                  state: { type: "string" },
                },
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "429": { $ref: "#/components/responses/RateLimited" },
        "503": { $ref: "#/components/responses/EncryptionKeyUnavailable" },
      },
    },
  },
  "/api/integrations/{packageId}/auths/{authKey}/connect/session": {
    post: {
      operationId: "initiateIntegrationConnect",
      tags: ["Integrations"],
      summary: "Mint a hosted Connect portal session (interactive, auth-type-agnostic)",
      description:
        "Porte A — the hosted **Connect** portal (issue #769), the primary interactive surface. Returns a single `connect_url` the caller opens; the server dispatches to the provider's OAuth screen or the platform-hosted credential form by auth type. The end-user enters the secret on the hosted form — it never transits the caller, the model, or the chat bundle. For server-to-server provisioning where the backend already holds the credential, use the programmatic surface instead (`importIntegrationConnection` / `initiateIntegrationOAuth`).",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        packageIdParam,
        authKeyParam,
      ],
      requestBody: {
        required: false,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                scopes: connectKickoffRelayProperties.scopes,
                force_account_select: { type: "boolean" },
                connection_id: connectKickoffRelayProperties.connection_id,
              },
              additionalProperties: false,
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Connect URL",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["connect_url", "expiresAt"],
                properties: {
                  connect_url: { type: "string", format: "uri" },
                  expiresAt: {
                    type: "string",
                    format: "date-time",
                    description: "Absolute expiry of the connect session (RFC 3339).",
                  },
                },
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/integrations/connect/start": {
    get: {
      operationId: "startIntegrationConnect",
      tags: ["Integrations"],
      summary: "Hosted connect dispatch (token)",
      description:
        "Public entry the connect URL points at. Verifies the single-use session token, pins a page cookie, then 302-redirects to the provider OAuth screen (oauth2) or the hosted form (non-oauth, and oauth2 of an integration declaring connection variables, which the form collects before `submitIntegrationConnect` starts the OAuth flow). On failure returns an HTML error page. Authenticated by the signed token, not a session.",
      parameters: [
        {
          name: "token",
          in: "query",
          required: true,
          schema: { type: "string" },
          description: "Connect-session capability token.",
        },
      ],
      responses: {
        // No 2xx: the handler either 302-redirects on success (valid token →
        // provider OAuth screen or hosted form) or renders an HTML error page
        // with the matching 4xx status. It never returns 200 — the previous
        // `200 "HTML error page (token missing/invalid/used)"` entry duplicated
        // the 400/410 error conditions (routes/integrations.ts:/connect/start
        // returns c.html(popupHtmlError(...), 400|410)), so each condition now
        // maps to exactly one status.
        "302": {
          description:
            "Redirect to the provider OAuth screen, or to the hosted form (non-oauth, or oauth2 with connection variables).",
        },
        "400": {
          description:
            "Missing token, or the oauth2 auth declares neither an issuer nor explicit endpoints (HTML error page). The link stays reusable — except on an auth that auto-provisions its client (DCR/CIMD), where every refusal burns it.",
          content: htmlErrorPage,
        },
        "403": {
          description:
            "The space has no OAuth client registered for this auth and none could be auto-provisioned; the page says the failure is permanent and to ask an administrator, while the operator-facing detail naming the exact remedy stays on the server log — this route carries no session (HTML error page). For an auth whose client is pre-registered the link stays reusable, so a retry after the administrator registers one needs no re-mint and the page says to open the link again. For an auth that auto-provisions its client at the authorization server (DCR/CIMD) the link is burned — reaching this refusal means a registration was already attempted upstream, and a reusable link would replay it on every click — so the page says to request a new connection link instead.",
          content: htmlErrorPage,
        },
        "410": {
          description: "Invalid, expired, or already-used token (HTML error page).",
          content: htmlErrorPage,
        },
        "429": { $ref: "#/components/responses/RateLimited" },
        "500": {
          description:
            "Integration cannot be connected / unexpected failure (HTML error page). Nothing was sent upstream, so the link stays reusable.",
          content: htmlErrorPage,
        },
        "502": {
          description:
            "Upstream provider failed to start the connection — transient (HTML error page). The link is burned; re-mint to retry.",
          content: htmlErrorPage,
        },
      },
    },
  },
  "/api/integrations/connect/context": {
    get: {
      operationId: "getIntegrationConnectContext",
      tags: ["Integrations"],
      summary: "Hosted form render context (page cookie)",
      description:
        "Returns the auth manifest + display metadata for the hosted credential form. Authenticated by the page cookie set during dispatch. Never returns a secret.",
      responses: {
        "200": {
          description: "Hosted connect context",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["packageId", "auth_key", "display_name", "auth"],
                properties: {
                  packageId: { type: "string" },
                  auth_key: { type: "string" },
                  display_name: { type: "string" },
                  icon: { type: ["string", "null"] },
                  auth: {
                    type: "object",
                    additionalProperties: true,
                    description:
                      "The auth declaration the form renders. Credentials the platform mints (the `private_key` of `@appstrate/ssh`) are removed from `credentials.schema` — display only; submissions are validated against the full schema.",
                  },
                  connection_id: { type: ["string", "null"] },
                  csrf: { type: ["string", "null"] },
                  variables: {
                    type: ["object", "null"],
                    required: ["schema", "values"],
                    properties: {
                      schema: {
                        type: "object",
                        additionalProperties: true,
                        description: "The integration's `variables.schema` (AFPS §7.12).",
                      },
                      values: {
                        type: "object",
                        additionalProperties: { type: "string" },
                        description:
                          "The values of the connection being reconnected, to prefill the form; `{}` on a fresh connect.",
                      },
                    },
                    description:
                      "The connection variables the form collects (AFPS §7.12); null when the integration declares none.",
                  },
                },
              },
            },
          },
        },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/integrations/connect/submit": {
    post: {
      operationId: "submitIntegrationConnect",
      tags: ["Integrations"],
      summary: "Hosted form credential submit (page cookie + CSRF)",
      description:
        "Persists credentials entered on the hosted form — or, for an oauth2 auth (reached only when the integration declares connection variables), starts its OAuth flow with the submitted `variables` and returns the provider URL to navigate to; the connection is then created by the callback. Context + actor come from the page cookie; the request carries only the credentials and/or the variables and echoes the CSRF nonce in the `x-connect-csrf` header. An oauth2 refusal mirrors `startIntegrationConnect`: a variable to fix is a 400 `validation_failed` and the form can be resubmitted; another refusal keeps its status with a generic detail, and keeps the page session only when it preceded any request to the authorization server; anything else is a 502 that ends the session.",
      parameters: [
        {
          name: "x-connect-csrf",
          in: "header",
          required: true,
          schema: { type: "string" },
          description: "Double-submit CSRF nonce (from GET /connect/context).",
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                credentials: {
                  type: "object",
                  additionalProperties: true,
                  description:
                    "The credential fields. Required for a non-oauth auth, refused for oauth2.",
                },
                variables: connectionVariablesSchema,
              },
              additionalProperties: false,
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Connection stored",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["ok"],
                properties: {
                  ok: { type: "boolean" },
                  connection: {
                    ...integrationConnectionSchema,
                    description: "The connection stored (non-oauth auth).",
                  },
                  redirect_url: {
                    type: "string",
                    format: "uri",
                    description:
                      "oauth2 auth: the authorization server's URL to navigate to; the callback creates the connection.",
                  },
                  handoff_steps: {
                    type: "array",
                    description:
                      "Present when the platform minted credentials for this auth (`@appstrate/ssh`): what the user must do with the material the platform minted, in order. Never contains a secret. Steps flagged `deferred` are due at deletion and are served again by `getMyConnectionHandoff`.",
                    items: { $ref: "#/components/schemas/HandoffStep" },
                  },
                },
              },
            },
          },
        },
        "400": {
          $ref: "#/components/responses/ValidationError",
          description: `Invalid body, CSRF token, credentials or variables. oauth2: any other 400 refusal of the flow is \`connection_not_ready\`, with a generic detail. ${CONNECT_LOGIN_400} The page session survives: the form can be submitted again.`,
        },
        "403": {
          description:
            "oauth2: the authorization server's client could not be provisioned or is refused (`connection_not_ready`); the detail is generic, the operator-facing reason stays on the server log.",
          content: {
            "application/problem+json": { schema: { $ref: "#/components/schemas/ProblemDetail" } },
          },
        },
        "404": {
          $ref: "#/components/responses/NotFound",
          description:
            "No active connect session, or the integration or auth is gone. oauth2: a 404 refusal of the flow is `connection_not_ready`, with a generic detail.",
        },
        "502": {
          description: `oauth2: the OAuth flow could not be started (\`connect_start_failed\`); the page session ends — request a new connection link. ${CONNECT_LOGIN_502} The page session survives.`,
          content: problemJson,
        },
        "429": { $ref: "#/components/responses/RateLimited" },
        ...connectRunResponses,
      },
    },
  },
  "/api/integrations/{packageId}/connections": {
    get: {
      operationId: "listIntegrationConnections",
      tags: ["Integrations"],
      summary: "List the connections the caller can use for an integration",
      description:
        "Returns the connections the caller can use from this space — the same set the runtime resolver picks from: the caller's own that reach the space (space-scoped ones of this space, and org-scoped ones unless the space registers a manual OAuth client for their auth, except in the space they were connected from), unless the space blocks member connections for this integration (`block_user_connections`), in which case only those shared into it; **plus** every connection another member shares into the space. Rows the caller does not own carry `owner_name`, have `identity_claims` redacted to `null`, and project `shared_space_ids` and `origin_space_id` (see their descriptions).",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        packageIdParam,
      ],
      responses: {
        "200": {
          description: "Connection list",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["object", "data", "hasMore"],
                properties: {
                  object: { type: "string", enum: ["list"] },
                  data: { type: "array", items: integrationConnectionSchema },
                  hasMore: { type: "boolean" },
                },
              },
            },
          },
        },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
  },
  "/api/integrations/{packageId}/connections/{connectionId}": {
    patch: {
      operationId: "updateIntegrationConnectionMetadata",
      tags: ["Integrations"],
      summary: "Rename an integration connection and/or set the spaces it is shared into",
      description: connectionUpdateDescription,
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        packageIdParam,
        connectionIdParam,
      ],
      requestBody: connectionUpdateRequestBody,
      responses: {
        "200": {
          description: "Updated — returns the bare connection resource",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              // Bare connection resource — same serializer as the
              // connections list / connect flows, not a hand-built
              // subset (#657).
              schema: integrationConnectionSchema,
            },
          },
        },
        "400": {
          $ref: "#/components/responses/ValidationError",
          description: connectionUpdateRefusals400,
        },
        "403": {
          $ref: "#/components/responses/Forbidden",
          description:
            "The caller neither owns the connection nor holds `integrations:configure` in this space, or holds it but asked for more than a governor may: renaming an org-scoped connection, or any `shared_space_ids` other than the current projection minus this space. Also: a delegated credential editing another space's share or renaming a connection not scoped to this space, and a requested target — added or kept — blocking user connections for the integration where the caller lacks `integrations:configure` (`connection_blocked_by_admin`).",
        },
        "404": {
          $ref: "#/components/responses/NotFound",
          description:
            "No connection with this id: of the caller and reaching this space, or scoped to or shared into it.",
        },
        "409": connectionUpdateConflicts,
      },
    },
  },
  "/api/integrations/{packageId}/settings": {
    patch: {
      operationId: "updateIntegrationSettings",
      tags: ["Integrations"],
      summary: "Toggle the per-(space, integration) block_user_connections gate (admin)",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        packageIdParam,
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["block_user_connections"],
              properties: { block_user_connections: { type: "boolean" } },
              additionalProperties: false,
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Updated — returns the bare integration detail resource",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              // Bare integration resource — same serializer as
              // GET /integrations/:packageId; the toggled gate is the
              // resource's `block_user_connections` field (#657).
              schema: integrationDetailSchema,
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/integrations/{packageId}/pins": {
    get: {
      operationId: "listIntegrationPins",
      tags: ["Integrations"],
      summary: "List admin pins for this integration in this space",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        packageIdParam,
      ],
      responses: {
        "200": {
          description: "Pin list",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["object", "data", "hasMore"],
                properties: {
                  object: { type: "string", enum: ["list"] },
                  data: {
                    type: "array",
                    items: { $ref: "#/components/schemas/IntegrationPin" },
                  },
                  hasMore: { type: "boolean" },
                },
              },
            },
          },
        },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
  },
  "/api/integrations/{packageId}/consuming-agents": {
    get: {
      operationId: "listAgentsConsumingIntegration",
      tags: ["Integrations"],
      summary: "List the space's agents whose deps declare this integration",
      description:
        "Drives the centralised pin management table on the integration detail page " +
        "(R2): admins pick an agent target without leaving the integration view.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        packageIdParam,
      ],
      responses: {
        "200": {
          description: "Consuming agents",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["object", "data", "hasMore"],
                properties: {
                  object: { type: "string", enum: ["list"] },
                  data: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["agent_package_id", "display_name"],
                      properties: {
                        agent_package_id: { type: "string" },
                        display_name: { type: "string" },
                      },
                    },
                  },
                  hasMore: { type: "boolean" },
                },
              },
            },
          },
        },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
  },
  "/api/integrations/{packageId}/pins/{agentPackageId}": {
    put: {
      operationId: "upsertIntegrationPin",
      tags: ["Integrations"],
      summary: "Pin a set of shared connections to an agent for all members of the space (admin)",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        packageIdParam,
        agentPackageIdParam,
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["connection_ids"],
              properties: {
                connection_ids: {
                  ...connectionIdSetJsonSchema,
                  description:
                    "The WHOLE pinned set, in the order the run binds it — this write replaces it; `[]` pins none (see the set schema). Each connection must belong to this integration, reach this space and be shared into it by the member who owns it.",
                },
              },
              additionalProperties: false,
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Pinned",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/IntegrationPin" } },
          },
        },
        "400": {
          $ref: "#/components/responses/ValidationError",
          description: `Refused: ${connectionSetRefusals}.`,
        },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": {
          $ref: "#/components/responses/NotFound",
          description:
            "A connection id that is unknown, not shared into this space by a member (an end user's connection never is), of another integration, or that does not reach this space — one answer for all, so an id cannot be probed — or the agent is not active in this space.",
        },
      },
    },
    delete: {
      operationId: "deleteIntegrationPin",
      tags: ["Integrations"],
      summary: "Remove an admin pin (admin)",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        packageIdParam,
        agentPackageIdParam,
      ],
      responses: {
        "204": {
          description: "Pin removed (idempotent — 204 whether the pin existed or not)",
          headers: STD_RESPONSE_HEADERS,
        },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
  },
  "/api/integrations/{packageId}/default": {
    get: {
      operationId: "getIntegrationOrgDefault",
      tags: ["Integrations"],
      summary: "Get the space-wide default connection for this integration",
      description:
        "The cross-agent governance baseline: one default connection set per (space, " +
        "integration) used by every consuming agent. `enforce: true` locks every member; " +
        "`enforce: false` is overridable by a member pin. Either way the set binds whole: a " +
        "member that is no longer reachable fails the run with `pinned_connection_unavailable` " +
        "rather than falling through. Returns 204 when unset.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        packageIdParam,
      ],
      responses: {
        "200": {
          description: "Org default (bare resource — same shape as PUT)",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: integrationOrgDefaultSchema,
            },
          },
        },
        "204": {
          description: "No org default is set for this integration",
          headers: STD_RESPONSE_HEADERS,
        },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
    put: {
      operationId: "upsertIntegrationOrgDefault",
      tags: ["Integrations"],
      summary: "Set the space-wide default connection for this integration (admin)",
      description:
        "Replace the (space, integration) default connection SET. Keyed per-integration, " +
        "NOT per-auth: the body carries the WHOLE set and this write replaces it, " +
        "`enforce` included. Selecting connections of a different auth type replaces " +
        "the current default rather than adding a second one.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        packageIdParam,
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              // `enforce` carries a server-side default (`false`), so it is
              // optional on the wire — the `default` beside it said as much.
              required: ["connection_ids"],
              properties: {
                connection_ids: {
                  ...orgDefaultConnectionIdSetJsonSchema,
                  description: "The WHOLE default set (1 or more ids) — this write replaces it.",
                },
                enforce: { type: "boolean", default: false },
              },
              additionalProperties: false,
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Default set",
          headers: STD_RESPONSE_HEADERS,
          content: { "application/json": { schema: integrationOrgDefaultSchema } },
        },
        "400": {
          $ref: "#/components/responses/ValidationError",
          description: `Refused: ${orgDefaultSetRefusals}.`,
        },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": {
          $ref: "#/components/responses/NotFound",
          description:
            "A connection id that is unknown, not shared into this space by a member (an end user's connection never is), of another integration, or that does not reach this space — one answer for all, so an id cannot be probed.",
        },
      },
    },
    delete: {
      operationId: "deleteIntegrationOrgDefault",
      tags: ["Integrations"],
      summary: "Remove the space-wide default connection (admin)",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        packageIdParam,
      ],
      responses: {
        "204": {
          description: "Default removed (idempotent — 204 whether a default existed or not)",
          headers: STD_RESPONSE_HEADERS,
        },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
  },
} as const;
