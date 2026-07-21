// SPDX-License-Identifier: Apache-2.0

/**
 * OpenAPI paths for the AFPS integration marketplace.
 *
 * Endpoints are app-scoped — `X-Application-Id` is enforced by the
 * platform-level `requireAppContext()` middleware.
 */

const packageIdParam = {
  name: "packageId",
  in: "path",
  required: true,
  description: "Integration package id (e.g. `@official/gmail`).",
  schema: { type: "string", pattern: "^@[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9-]*$" },
} as const;

const authKeyParam = {
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

const clientIdParam = {
  name: "clientId",
  in: "path",
  required: true,
  description: "Custom OAuth client id (`integration_oauth_clients.id`, UUID).",
  schema: { type: "string", format: "uuid" },
} as const;

const agentPackageIdParam = {
  name: "agentPackageId",
  in: "path",
  required: true,
  description: "Agent package id (e.g. `@acme/my-agent`).",
  schema: { type: "string", pattern: "^@[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9-]*$" },
} as const;

// The org default is keyed by (application, integration) ONLY — a single row
// per integration, NOT one per (integration, auth_key). The unique index in
// `integrationOrgDefaults` and the `onConflictDoUpdate` in
// `integration-org-defaults-service.ts:upsertOrgDefault` both target
// [applicationId, integrationId], so PUT overwrites the one existing default
// wholesale. `auth_key` below is a DERIVED read-only projection of the chosen
// connection's own auth (joined from `integration_connections` at read time) —
// it does NOT partition the default. Picking a connection of a different auth
// type replaces the single default; it does not create a second, per-auth one.
const integrationOrgDefaultSchema = {
  type: "object",
  required: [
    "integration_package_id",
    "connection_id",
    "auth_key",
    "enforce",
    "createdAt",
    "updatedAt",
  ],
  properties: {
    integration_package_id: { type: "string" },
    connection_id: { type: "string", format: "uuid" },
    auth_key: {
      type: "string",
      description:
        "Auth type of the chosen connection, derived (joined) from the connection row — NOT a key dimension. There is exactly one default per (application, integration) regardless of auth_key; this field just tells you which auth the current default connection uses.",
    },
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
    source: { type: "string", enum: ["local", "system"] },
    active: { type: "boolean" },
    block_user_connections: { type: "boolean" },
  },
} as const;

// CASING: this connection wire shape mixes camelCase and snake_case by policy,
// not by oversight. `id`, `packageId`, `expiresAt`, `createdAt`, `updatedAt`
// are the universal DB-convention carve-outs (camelCase everywhere per
// docs/CASING_CONVENTIONS.md); every other field (`auth_key`, `account_id`,
// `identity_claims`, `scopes_granted`, `needs_reconnection`, `owner_type`,
// `owner_id`, `shared_with_org`, `client_ref`) is snake_case wire. Matches the
// serializer output (spec==runtime) — do NOT normalize either way.
const integrationConnectionSchema = {
  type: "object",
  required: [
    "id",
    "packageId",
    "auth_key",
    "account_id",
    "identity_claims",
    "scopes_granted",
    "needs_reconnection",
    "expiresAt",
    "owner_type",
    "owner_id",
    "client_ref",
    "createdAt",
    "updatedAt",
  ],
  properties: {
    id: { type: "string", format: "uuid" },
    packageId: { type: "string" },
    auth_key: { type: "string" },
    account_id: { type: "string" },
    identity_claims: { type: ["object", "null"], additionalProperties: true },
    scopes_granted: { type: "array", items: { type: "string" } },
    needs_reconnection: { type: "boolean" },
    expiresAt: { type: ["string", "null"], format: "date-time" },
    owner_type: { type: "string", enum: ["user", "end_user"] },
    owner_id: { type: "string" },
    label: { type: ["string", "null"] },
    shared_with_org: { type: "boolean" },
    client_ref: {
      type: ["string", "null"],
      description:
        "The registered OAuth client that minted this connection (system env id or custom `integration_oauth_clients.id`). Null for non-oauth2 auths. The connection is bound to it — changing it requires reconnecting.",
    },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
} as const;

// Shared by GET .../clients and PUT .../default-client — both return the
// available-clients list so the UI re-badges the default in one round-trip.
const integrationClientsListSchema = {
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
          "redirect_uri",
        ],
        properties: {
          client_ref: { type: "string" },
          source: { type: "string", enum: ["built-in", "custom"] },
          client_id: {
            type: "string",
            description:
              "For `custom` clients, the org's OAuth client_id. For `built-in` (system) clients, an opaque `sys_`-prefixed fingerprint (truncated SHA-256) — never the real system client_id, which is a deployment secret. Display-only; the connect/refresh keyspace is `client_ref`.",
          },
          is_default: { type: "boolean" },
          auto_provisioned: { type: "boolean" },
          has_client_secret: { type: "boolean" },
          redirect_uri: { type: ["string", "null"] },
        },
      },
    },
  },
} as const;

const oauthClientSchema = {
  type: "object",
  required: [
    "id",
    "applicationId",
    "integration_package_id",
    "auth_key",
    "client_id",
    "has_client_secret",
    "redirect_uri",
    "createdAt",
    "updatedAt",
  ],
  properties: {
    id: {
      type: "string",
      format: "uuid",
      description:
        "Row UUID — the `client_ref` handle passed to the rotate / delete / default-client routes.",
    },
    applicationId: { type: "string" },
    integration_package_id: { type: "string" },
    auth_key: { type: "string" },
    client_id: { type: "string" },
    has_client_secret: { type: "boolean" },
    redirect_uri: { type: ["string", "null"] },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
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
    required: { type: "boolean" },
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
    has_oauth_client: { type: "boolean" },
    has_system_client: {
      type: "boolean",
      description:
        "True when the platform provides a shared system OAuth client for this auth via `SYSTEM_INTEGRATIONS`. Connect falls back to it when the org has not registered its own client, so the auth is connectable without a pre-registered org client.",
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
    // Activation state in the current application — resource state shared
    // with the list endpoint, returned by every detail-shaped response
    // (GET detail, POST activate, PATCH settings).
    active: { type: "boolean" },
    // Admin gate (`block_user_connections`): when `true`, only org admins
    // may create personal connections. `false` when not activated.
    block_user_connections: { type: "boolean" },
  },
} as const;

const baseResponseHeaders = {
  "Request-Id": { $ref: "#/components/headers/RequestId" },
  "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
} as const;

export const integrationsPaths = {
  "/api/integrations": {
    get: {
      operationId: "listIntegrations",
      tags: ["Integrations"],
      summary: "List available integrations",
      description:
        "List every AFPS integration accessible to the current org (own + system), enriched with `active` + `block_user_connections` flags for the current application. Supports offset pagination (`limit`/`offset`) and a `fields` projection selector — request `?fields=id,source` to drop the heavy per-row `manifest` and fetch only what you need.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        {
          name: "limit",
          in: "query",
          schema: { type: "integer", minimum: 1, maximum: 100, default: 100 },
        },
        {
          name: "offset",
          in: "query",
          schema: { type: "integer", minimum: 0, default: 0 },
        },
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
          headers: baseResponseHeaders,
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
        "Browser-side OAuth callback. Exchanges code + state for tokens, persists the connection, and returns an HTML page that closes the popup window.",
      parameters: [
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
      ],
      responses: {
        "200": {
          description:
            "HTML page that closes the popup window. Renders either a success page or an error page (missing params, IdP error, code exchange failure, identity mismatch, or persistence failure).",
          headers: baseResponseHeaders,
        },
      },
    },
  },
  "/api/integrations/{packageId}": {
    get: {
      operationId: "getIntegration",
      tags: ["Integrations"],
      summary: "Get integration detail + per-auth status",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        packageIdParam,
      ],
      responses: {
        "200": {
          description: "Integration detail",
          headers: baseResponseHeaders,
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
  "/api/integrations/{packageId}/activate": {
    post: {
      operationId: "activateIntegration",
      tags: ["Integrations"],
      summary: "Activate an integration in the current application",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        packageIdParam,
      ],
      requestBody: {
        required: false,
        content: {
          "application/json": {
            schema: { type: "object", additionalProperties: false },
          },
        },
      },
      responses: {
        "201": {
          // Activation is a flag upsert (enabled=true) — idempotent: repeat
          // activation of an already-active integration succeeds (201), it is
          // not a 409.
          description: "Activated — returns the bare integration detail resource",
          headers: baseResponseHeaders,
          content: {
            "application/json": {
              // Bare integration resource — same serializer as
              // GET /integrations/:packageId. Activation state is the
              // resource's `active` field, not an operation scrap (#657).
              schema: integrationDetailSchema,
            },
          },
        },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": {
          description: "Wrong package type (not an integration)",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
      },
    },
  },
  "/api/integrations/{packageId}/deactivate": {
    delete: {
      operationId: "deactivateIntegration",
      tags: ["Integrations"],
      summary: "Deactivate an integration in the current application (non-destructive)",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        packageIdParam,
      ],
      responses: {
        "204": {
          // Deactivation flips `enabled` to false (an upsert — the row is the
          // explicit opt-out, persisted, not deleted: deleting it would let a
          // system integration re-trigger its auto-active default). The strict
          // mutation convention still applies: DELETE → 204 empty (#657). The
          // integration detail stays GET-able afterwards (connections, OAuth
          // clients, pins and org defaults survive) and serves `active: false`.
          description: "Deactivated — empty response. The integration detail remains GET-able.",
          headers: baseResponseHeaders,
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
        "Registers a NEW custom (BYO-app) client for this auth. Repeatable — an " +
        "org may hold N clients per auth (model-provider pattern). The first " +
        "registered client becomes the default; later ones are non-default until " +
        "promoted via PUT .../default-client. Rejected for auto-provisioned " +
        "(DCR/CIMD) auths. Admin only.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        packageIdParam,
        authKeyParam,
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["client_id", "client_secret"],
              properties: {
                client_id: { type: "string", minLength: 1 },
                client_secret: { type: "string", default: "" },
                redirect_uri: { type: "string", format: "uri" },
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Created",
          headers: baseResponseHeaders,
          content: { "application/json": { schema: oauthClientSchema } },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/integrations/{packageId}/oauth-clients/{clientId}": {
    put: {
      operationId: "rotateIntegrationOAuthClient",
      tags: ["Integrations"],
      summary: "Rotate a custom OAuth client's credentials",
      description:
        "Rotates one custom client in place, by its id. Auto-provisioned " +
        "(DCR/CIMD) clients are machine-managed and rejected. Admin only.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        packageIdParam,
        clientIdParam,
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["client_id", "client_secret"],
              properties: {
                client_id: { type: "string", minLength: 1 },
                client_secret: { type: "string", default: "" },
                redirect_uri: { type: "string", format: "uri" },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Rotated",
          headers: baseResponseHeaders,
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
        "Deletes one custom client by id. If it was the default, the cascade " +
        "falls to the system client (no auto-promotion). Admin only.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        packageIdParam,
        clientIdParam,
      ],
      responses: {
        "204": {
          description: "OAuth client deleted",
          headers: baseResponseHeaders,
        },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/integrations/{packageId}/auths/{authKey}/clients": {
    get: {
      operationId: "listIntegrationClients",
      tags: ["Integrations"],
      summary: "List the OAuth clients registered for an integration auth",
      description:
        "Returns the org's custom (BYO-app) clients plus any platform-provided " +
        "system clients, with `source` and which is the default. Secrets are " +
        "never returned. Drives the admin clients CRUD table; new connections " +
        "always use the default (no per-connect picker).",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        packageIdParam,
        authKeyParam,
      ],
      responses: {
        "200": {
          description: "Available OAuth clients",
          headers: baseResponseHeaders,
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
        "(the model-provider `setDefaultModel` analogue). Selecting the org's custom " +
        "client flags it default; selecting a system client un-flags the custom one " +
        "so the cascade falls to the system client. Existing connections are bound " +
        "to the client that minted them and are unaffected. Returns the refreshed " +
        "clients list. Admin only.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        packageIdParam,
        authKeyParam,
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["client_ref"],
              properties: {
                client_ref: {
                  type: "string",
                  description: "Client to make default — a `client_ref` from GET .../clients.",
                },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Default set; available OAuth clients (re-badged)",
          headers: baseResponseHeaders,
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
        "Porte B (programmatic/headless): the backend already holds the credential and submits it directly to create the connection — the server-to-server analogue of the hosted Connect portal. Use for api_key / basic / custom auths. For OAuth2 auths use the headless OAuth start (`initiateIntegrationOAuth`); for interactive/human flows where the secret should never transit the caller, use the hosted Connect portal (`initiateIntegrationConnect`).",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
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
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Connection stored",
          headers: baseResponseHeaders,
          content: { "application/json": { schema: integrationConnectionSchema } },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
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
        { $ref: "#/components/parameters/XAppId" },
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
                scopes: { type: "array", items: { type: "string" } },
                force_account_select: { type: "boolean" },
                connection_id: { type: "string", format: "uuid" },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Authorize URL",
          headers: baseResponseHeaders,
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
        { $ref: "#/components/parameters/XAppId" },
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
                scopes: { type: "array", items: { type: "string" } },
                force_account_select: { type: "boolean" },
                connection_id: {
                  type: "string",
                  format: "uuid",
                  description: "Reconnect/upgrade an existing connection in place.",
                },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Connect URL",
          headers: baseResponseHeaders,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["connect_url", "expires_at"],
                properties: {
                  connect_url: { type: "string", format: "uri" },
                  expires_at: {
                    type: "integer",
                    description: "Absolute expiry of the connect session (epoch ms).",
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
      security: [],
      tags: ["Integrations"],
      summary: "Hosted connect dispatch (token)",
      description:
        "Public entry the connect URL points at. Verifies the single-use session token, pins a page cookie, then 302-redirects to the provider OAuth screen (oauth2) or the hosted form (non-oauth). On failure returns an HTML error page. Authenticated by the signed token, not a session.",
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
        "302": { description: "Redirect to the provider OAuth screen or the hosted form." },
        "400": { description: "Missing token (HTML error page)." },
        "410": { description: "Invalid, expired, or already-used token (HTML error page)." },
        "500": {
          description: "Integration cannot be connected / unexpected failure (HTML error page).",
        },
        "502": {
          description: "Upstream provider failed to start the connection (HTML error page).",
        },
      },
    },
  },
  "/api/integrations/connect/context": {
    get: {
      operationId: "getIntegrationConnectContext",
      security: [{ connectPageCookie: [] }],
      tags: ["Integrations"],
      summary: "Hosted form render context (page cookie)",
      description:
        "Returns the auth manifest + display metadata for the hosted credential form. Authenticated by the page cookie set during dispatch. Never returns a secret.",
      responses: {
        "200": {
          description: "Hosted connect context",
          headers: baseResponseHeaders,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: [
                  "package_id",
                  "auth_key",
                  "display_name",
                  "auth",
                  "connection_id",
                  "csrf",
                  "companion",
                ],
                properties: {
                  package_id: { type: "string" },
                  auth_key: { type: "string" },
                  display_name: { type: "string" },
                  icon: { type: ["string", "null"] },
                  auth: { type: "object", additionalProperties: true },
                  connection_id: { type: ["string", "null"] },
                  csrf: { type: ["string", "null"] },
                  companion: {
                    oneOf: [
                      { type: "null" },
                      {
                        type: "object",
                        required: ["available", "target_provider"],
                        properties: {
                          available: { type: "boolean", const: true },
                          target_provider: {
                            type: "string",
                            enum: ["browser-use-cloud", "process"],
                          },
                        },
                      },
                    ],
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
  "/api/integrations/connect/companion/attempts": {
    post: {
      operationId: "createBrowserCompanionAttempt",
      security: [{ connectPageCookie: [] }],
      tags: ["Integrations"],
      summary: "Create a local browser companion handoff",
      description:
        "Authenticated by the hosted-connect page cookie plus CSRF. Allocates a connection-scoped target browser profile and returns a one-time local-app capability. The capability response is non-cacheable.",
      parameters: [
        {
          name: "x-connect-csrf",
          in: "header",
          required: true,
          schema: { type: "string" },
        },
      ],
      requestBody: {
        required: false,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                target_provider: {
                  type: "string",
                  enum: ["browser-use-cloud", "process"],
                  description:
                    "Optional echo of the operator-selected provider. A different value is rejected.",
                },
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Companion attempt created",
          headers: baseResponseHeaders,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["attempt_id", "companion_url", "expires_at"],
                properties: {
                  attempt_id: { type: "string", format: "uuid" },
                  companion_url: { type: "string", format: "uri" },
                  expires_at: { type: "string", format: "date-time" },
                },
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/integrations/connect/companion/attempts/{attemptId}": {
    get: {
      operationId: "getBrowserCompanionAttempt",
      security: [{ companionBearer: [] }],
      tags: ["Integrations"],
      summary: "Read a browser companion attempt",
      description:
        "Polled by the local companion and hosted connect page using the attempt bearer. Live provider URLs remain encrypted at rest and are returned only here.",
      parameters: [
        {
          name: "attemptId",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
        {
          name: "observe",
          in: "query",
          required: false,
          schema: { type: "string", enum: ["1"] },
          description:
            "Read without claiming the attempt. Used by the hosted page so pending means the local companion has not connected yet.",
        },
      ],
      responses: {
        "200": {
          description: "Companion attempt state",
          headers: baseResponseHeaders,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: [
                  "attempt_id",
                  "package_id",
                  "display_name",
                  "icon",
                  "start_url",
                  "allowed_origins",
                  "target_provider",
                  "status",
                  "interaction_url",
                  "error_code",
                  "expires_at",
                ],
                properties: {
                  attempt_id: { type: "string", format: "uuid" },
                  package_id: { type: "string" },
                  display_name: { type: "string" },
                  icon: { type: ["string", "null"] },
                  start_url: { type: "string", format: "uri" },
                  allowed_origins: {
                    type: "array",
                    items: { type: "string", format: "uri" },
                  },
                  target_provider: {
                    type: "string",
                    enum: ["browser-use-cloud", "process"],
                  },
                  status: {
                    type: "string",
                    enum: [
                      "pending",
                      "claimed",
                      "state_received",
                      "provisioning",
                      "interaction_required",
                      "complete",
                      "failed",
                    ],
                  },
                  interaction_url: { type: ["string", "null"], format: "uri" },
                  error_code: { type: ["string", "null"] },
                  expires_at: { type: "string", format: "date-time" },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
      },
    },
  },
  "/api/integrations/connect/companion/attempts/{attemptId}/failure": {
    post: {
      operationId: "failBrowserCompanionAttempt",
      security: [{ companionBearer: [] }],
      tags: ["Integrations"],
      summary: "Report that local browser acquisition stopped",
      description:
        "Allows the authenticated local companion to end a pending or claimed attempt immediately. This transition cannot interrupt a handoff that has already entered provider provisioning.",
      parameters: [
        {
          name: "attemptId",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["reason"],
              properties: {
                reason: { type: "string", enum: ["closed", "timeout", "failed"] },
              },
            },
          },
        },
      },
      responses: {
        "202": {
          description: "Failure accepted or ignored because handoff already started",
          headers: baseResponseHeaders,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["accepted"],
                properties: { accepted: { type: "boolean", const: true } },
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
      },
    },
  },
  "/api/integrations/connect/companion/attempts/{attemptId}/handoff": {
    post: {
      operationId: "submitBrowserCompanionHandoff",
      security: [{ companionBearer: [] }],
      tags: ["Integrations"],
      summary: "Submit local browser state for target-provider proof",
      description:
        "Accepts a bounded browser state from the local companion. The state is encrypted immediately and asynchronously restored into the allocated target profile; callers poll the attempt resource for completion.",
      parameters: [
        {
          name: "attemptId",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["browser_state"],
              properties: { browser_state: { type: "string", maxLength: 921600 } },
            },
          },
        },
      },
      responses: {
        "202": {
          description: "State accepted for asynchronous proof",
          headers: baseResponseHeaders,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["attempt_id", "status"],
                properties: {
                  attempt_id: { type: "string", format: "uuid" },
                  status: { type: "string", enum: ["state_received"] },
                },
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
      },
    },
  },
  "/api/integrations/connect/submit": {
    post: {
      operationId: "submitIntegrationConnect",
      security: [{ connectPageCookie: [] }],
      tags: ["Integrations"],
      summary: "Hosted form credential submit (page cookie + CSRF)",
      description:
        "Persists credentials entered on the hosted form. Context + actor come from the page cookie; the request carries only the credentials and echoes the CSRF nonce in the `x-connect-csrf` header. Browser-backed acquisition returns an SSE stream with `interaction`, `complete`, or `error` events so human challenges can be completed in the provider's secure live session.",
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
              required: ["credentials"],
              properties: {
                credentials: { type: "object", additionalProperties: true },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Connection stored",
          headers: baseResponseHeaders,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["ok", "connection"],
                properties: {
                  ok: { type: "boolean" },
                  connection: integrationConnectionSchema,
                },
              },
            },
            "text/event-stream": {
              schema: {
                type: "string",
                description:
                  "Browser acquisition event stream. `interaction` carries `{ url }`; terminal `complete` carries the stored connection and terminal `error` carries a safe problem summary.",
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/integrations/{packageId}/connections": {
    get: {
      operationId: "listIntegrationConnections",
      tags: ["Integrations"],
      summary: "List the caller's connections for an integration",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        packageIdParam,
      ],
      responses: {
        "200": {
          description: "Connection list",
          headers: baseResponseHeaders,
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
      summary: "Update an integration connection's label and/or shared_with_org flag",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        packageIdParam,
        connectionIdParam,
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                label: { type: ["string", "null"], maxLength: 80 },
                shared_with_org: { type: "boolean" },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Updated — returns the bare connection resource",
          headers: baseResponseHeaders,
          content: {
            "application/json": {
              // Bare connection resource — same serializer as the
              // connections list / connect flows, not a hand-built
              // subset (#657).
              schema: integrationConnectionSchema,
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": {
          description: "Connection is pinned and cannot be unshared",
          headers: baseResponseHeaders,
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
      },
    },
  },
  "/api/integrations/{packageId}/settings": {
    patch: {
      operationId: "updateIntegrationSettings",
      tags: ["Integrations"],
      summary: "Toggle the per-(app, integration) block_user_connections gate (admin)",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
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
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Updated — returns the bare integration detail resource",
          headers: baseResponseHeaders,
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
      summary: "List admin pins for this integration in this application",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        packageIdParam,
      ],
      responses: {
        "200": {
          description: "Pin list",
          headers: baseResponseHeaders,
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
      summary: "List installed agents whose deps declare this integration",
      description:
        "Drives the centralised pin management table on the integration detail page " +
        "(R2): admins pick an installed-agent target without leaving the integration view.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        packageIdParam,
      ],
      responses: {
        "200": {
          description: "Consuming agents",
          headers: baseResponseHeaders,
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
                      required: ["packageId", "display_name"],
                      properties: {
                        packageId: { type: "string" },
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
      summary: "Pin an admin-shared connection to an agent for all members (admin)",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        packageIdParam,
        agentPackageIdParam,
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["connection_id"],
              properties: { connection_id: { type: "string", format: "uuid" } },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Pinned",
          headers: baseResponseHeaders,
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/IntegrationPin" } },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    delete: {
      operationId: "deleteIntegrationPin",
      tags: ["Integrations"],
      summary: "Remove an admin pin (admin)",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        packageIdParam,
        agentPackageIdParam,
      ],
      responses: {
        "204": {
          description: "Pin removed (idempotent — 204 whether the pin existed or not)",
          headers: baseResponseHeaders,
        },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
  },
  "/api/integrations/{packageId}/default": {
    get: {
      operationId: "getIntegrationOrgDefault",
      tags: ["Integrations"],
      summary: "Get the org-wide default connection for this integration",
      description:
        "The cross-agent governance baseline: one default connection per (application, " +
        "integration) used by every consuming agent. `enforce: true` locks every member; " +
        "`enforce: false` is overridable by a member pin. Returns 204 when unset.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        packageIdParam,
      ],
      responses: {
        "200": {
          description: "Org default (bare resource — same shape as PUT)",
          headers: baseResponseHeaders,
          content: {
            "application/json": {
              schema: integrationOrgDefaultSchema,
            },
          },
        },
        "204": {
          description: "No org default is set for this integration",
          headers: baseResponseHeaders,
        },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
    put: {
      operationId: "upsertIntegrationOrgDefault",
      tags: ["Integrations"],
      summary: "Set the org-wide default connection for this integration (admin)",
      description:
        "Upsert the single (application, integration) default. Keyed per-integration, " +
        "NOT per-auth: this overwrites the one existing default wholesale (atomic " +
        "onConflictDoUpdate on [applicationId, integrationId]). Selecting a connection " +
        "of a different auth type replaces the current default rather than adding a " +
        "second one. The response `auth_key` reflects the chosen connection's auth (derived).",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        packageIdParam,
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["connection_id", "enforce"],
              properties: {
                connection_id: { type: "string", format: "uuid" },
                enforce: { type: "boolean", default: false },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Default set",
          headers: baseResponseHeaders,
          content: { "application/json": { schema: integrationOrgDefaultSchema } },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    delete: {
      operationId: "deleteIntegrationOrgDefault",
      tags: ["Integrations"],
      summary: "Remove the org-wide default connection (admin)",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        packageIdParam,
      ],
      responses: {
        "204": {
          description: "Default removed (idempotent — 204 whether a default existed or not)",
          headers: baseResponseHeaders,
        },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
  },
} as const;
