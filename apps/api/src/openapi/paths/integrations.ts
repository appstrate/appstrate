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

const agentPackageIdParam = {
  name: "agentPackageId",
  in: "path",
  required: true,
  description: "Agent package id (e.g. `@acme/my-agent`).",
  schema: { type: "string", pattern: "^@[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9-]*$" },
} as const;

const integrationPinSchema = {
  type: "object",
  required: [
    "packageId",
    "integration_package_id",
    "auth_key",
    "connection_id",
    "createdAt",
    "updatedAt",
  ],
  properties: {
    packageId: { type: "string" },
    integration_package_id: { type: "string" },
    auth_key: { type: "string" },
    connection_id: { type: "string", format: "uuid" },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
} as const;

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
    auth_key: { type: "string" },
    enforce: { type: "boolean" },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
} as const;

const integrationSummarySchema = {
  type: "object",
  required: ["id", "manifest", "orgId", "source"],
  properties: {
    id: { type: "string" },
    manifest: { type: "object", additionalProperties: true },
    orgId: { type: ["string", "null"] },
    source: { type: "string", enum: ["local", "system"] },
    active: { type: "boolean" },
    block_user_connections: { type: "boolean" },
  },
} as const;

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
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
} as const;

const oauthClientSchema = {
  type: "object",
  required: [
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
    "has_oauth_client",
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
    has_oauth_client: { type: "boolean" },
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
        required_scopes: { type: "array", items: { type: "string" } },
        required_auth_key: { type: "string" },
        url_patterns: {
          type: "array",
          items: {
            type: "object",
            required: ["pattern"],
            properties: {
              pattern: { type: "string" },
              methods: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
    },
  },
} as const;

const integrationDetailSchema = {
  type: "object",
  required: ["manifest", "auths", "tool_catalog"],
  properties: {
    manifest: { type: "object", additionalProperties: true },
    auths: { type: "array", items: authStatusSchema },
    // Effective agent-facing tool catalog. Resolved server-side from the
    // referenced mcp-server's MCPB `tools[]` (local source) minus
    // `hidden_tools` and auto-hidden connect.tool primitives. Falls back
    // to `manifest.tools_policy` keys when the mcp-server is absent.
    tool_catalog: { type: "array", items: toolCatalogEntrySchema },
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
        "List every AFPS integration accessible to the current org (own + system), enriched with `active` + `block_user_connections` flags for the current application.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
      ],
      responses: {
        "200": {
          description: "Integration list",
          headers: baseResponseHeaders,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["object", "data", "hasMore"],
                properties: {
                  object: { type: "string", enum: ["list"] },
                  data: { type: "array", items: integrationSummarySchema },
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
          description: "HTML response that closes the popup",
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
        "404": { $ref: "#/components/responses/NotFound" },
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
          description: "Activated",
          headers: baseResponseHeaders,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["active", "activated_at"],
                properties: {
                  active: { type: "boolean" },
                  activated_at: { type: "string", format: "date-time" },
                },
              },
            },
          },
        },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": {
          description: "Already active or wrong package type",
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
        "200": {
          description: "Deactivated",
          headers: baseResponseHeaders,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["active"],
                properties: { active: { type: "boolean" } },
              },
            },
          },
        },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/integrations/{packageId}/oauth-clients/{authKey}": {
    get: {
      operationId: "getIntegrationOAuthClient",
      tags: ["Integrations"],
      summary: "Read the registered OAuth client for an integration auth",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        packageIdParam,
        authKeyParam,
      ],
      responses: {
        "200": {
          description: "OAuth client",
          headers: baseResponseHeaders,
          content: { "application/json": { schema: oauthClientSchema } },
        },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    put: {
      operationId: "upsertIntegrationOAuthClient",
      tags: ["Integrations"],
      summary: "Register or rotate the OAuth client for an integration auth",
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
        "200": {
          description: "Upserted",
          headers: baseResponseHeaders,
          content: { "application/json": { schema: oauthClientSchema } },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
      },
    },
    delete: {
      operationId: "deleteIntegrationOAuthClient",
      tags: ["Integrations"],
      summary: "Delete the OAuth client for an integration auth",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        packageIdParam,
        authKeyParam,
      ],
      responses: {
        "200": {
          description: "Deleted",
          headers: baseResponseHeaders,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["deleted"],
                properties: { deleted: { type: "boolean" } },
              },
            },
          },
        },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/integrations/{packageId}/auths/{authKey}/connect/fields": {
    post: {
      operationId: "connectIntegrationFields",
      tags: ["Integrations"],
      summary: "Connect an api_key / basic / custom integration auth",
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
                  additionalProperties: { type: "string" },
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
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/integrations/{packageId}/auths/{authKey}/connect/oauth2": {
    post: {
      operationId: "initiateIntegrationOAuth",
      tags: ["Integrations"],
      summary: "Initiate the OAuth2 PKCE flow for an integration auth",
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
                required: ["authUrl", "state"],
                properties: {
                  authUrl: { type: "string", format: "uri" },
                  state: { type: "string" },
                },
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "403": { $ref: "#/components/responses/Forbidden" },
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
      },
    },
  },
  "/api/integrations/{packageId}/agent-resolution/{agentPackageId}": {
    get: {
      operationId: "resolveAgentIntegrationConnection",
      tags: ["Integrations"],
      summary: "Resolve which connection an agent uses for an integration",
      description:
        "Single-source verdict for the agent-page connection picker. Returns which " +
        "connection the next run would use (admin pin → run/schedule override → member " +
        "pin → fallback + scope check), the annotated candidate list (own + shared, each " +
        "with the scopes it lacks for the agent's selected tools), and the admin/member " +
        "pin + blocked state. Computed by the same resolver the runtime uses so the UI " +
        "never re-implements the cascade.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        packageIdParam,
        agentPackageIdParam,
      ],
      responses: {
        "200": {
          description: "Resolution verdict",
          headers: baseResponseHeaders,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: [
                  "status",
                  "resolved_connection_id",
                  "resolved_missing_scopes",
                  "resolved_owned_by_actor",
                  "admin_pinned_connection_id",
                  "member_pinned_connection_id",
                  "can_add_connection",
                  "candidates",
                ],
                properties: {
                  status: {
                    type: "string",
                    enum: [
                      "admin_locked",
                      "pinned",
                      "auto",
                      "must_choose",
                      "none",
                      "stale",
                      "needs_reconnection",
                    ],
                  },
                  resolved_connection_id: { type: ["string", "null"] },
                  resolved_missing_scopes: { type: "array", items: { type: "string" } },
                  resolved_owned_by_actor: { type: "boolean" },
                  admin_pinned_connection_id: { type: ["string", "null"] },
                  member_pinned_connection_id: { type: ["string", "null"] },
                  org_default_connection_id: { type: ["string", "null"] },
                  org_default_enforced: { type: "boolean" },
                  can_add_connection: { type: "boolean" },
                  candidates: {
                    type: "array",
                    items: {
                      type: "object",
                      required: [
                        "id",
                        "auth_key",
                        "account_id",
                        "label",
                        "owner_user_id",
                        "owner_end_user_id",
                        "owner_name",
                        "scopes_granted",
                        "shared_with_org",
                        "needs_reconnection",
                        "missing_scopes",
                        "is_own",
                      ],
                      properties: {
                        id: { type: "string", format: "uuid" },
                        auth_key: { type: "string" },
                        account_id: { type: "string" },
                        label: { type: ["string", "null"] },
                        owner_user_id: { type: ["string", "null"] },
                        owner_end_user_id: { type: ["string", "null"] },
                        owner_name: { type: ["string", "null"] },
                        scopes_granted: { type: "array", items: { type: "string" } },
                        shared_with_org: { type: "boolean" },
                        needs_reconnection: { type: "boolean" },
                        missing_scopes: { type: "array", items: { type: "string" } },
                        is_own: { type: "boolean" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
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
          description: "Updated",
          headers: baseResponseHeaders,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["id", "label", "shared_with_org", "updatedAt"],
                properties: {
                  id: { type: "string", format: "uuid" },
                  label: { type: ["string", "null"] },
                  shared_with_org: { type: "boolean" },
                  updatedAt: { type: "string", format: "date-time" },
                },
              },
            },
          },
        },
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
          description: "Updated",
          headers: baseResponseHeaders,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["blocked"],
                properties: { blocked: { type: "boolean" } },
              },
            },
          },
        },
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
                  data: { type: "array", items: integrationPinSchema },
                  hasMore: { type: "boolean" },
                },
              },
            },
          },
        },
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
          content: { "application/json": { schema: integrationPinSchema } },
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
        "200": {
          description: "Deleted",
          headers: baseResponseHeaders,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["deleted"],
                properties: { deleted: { type: "boolean" } },
              },
            },
          },
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
        "`enforce: false` is overridable by a member pin. Returns `{ default: null }` when unset.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        packageIdParam,
      ],
      responses: {
        "200": {
          description: "Org default (or null)",
          headers: baseResponseHeaders,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["default"],
                properties: {
                  default: { anyOf: [integrationOrgDefaultSchema, { type: "null" }] },
                },
              },
            },
          },
        },
      },
    },
    put: {
      operationId: "upsertIntegrationOrgDefault",
      tags: ["Integrations"],
      summary: "Set the org-wide default connection for this integration (admin)",
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
        "200": {
          description: "Deleted",
          headers: baseResponseHeaders,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["deleted"],
                properties: { deleted: { type: "boolean" } },
              },
            },
          },
        },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
  },
} as const;
