// SPDX-License-Identifier: Apache-2.0

/**
 * OpenAPI paths for the AFPS integration marketplace
 * (INTEGRATIONS_PROPOSAL Phase 1.3).
 *
 * Endpoints are app-scoped — `X-Application-Id` is enforced by the
 * platform-level `requireAppContext()` middleware.
 */

const integrationPackageIdParam = {
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
    "integrationPackageId",
    "authKey",
    "connectionId",
    "createdAt",
    "updatedAt",
  ],
  properties: {
    packageId: { type: "string" },
    integrationPackageId: { type: "string" },
    authKey: { type: "string" },
    connectionId: { type: "string", format: "uuid" },
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
    installed: { type: "boolean" },
    blockUserConnections: { type: "boolean" },
  },
} as const;

const integrationConnectionSchema = {
  type: "object",
  required: [
    "id",
    "packageId",
    "authKey",
    "accountId",
    "identityClaims",
    "scopesGranted",
    "needsReconnection",
    "expiresAt",
    "ownerType",
    "ownerId",
    "createdAt",
    "updatedAt",
  ],
  properties: {
    id: { type: "string", format: "uuid" },
    packageId: { type: "string" },
    authKey: { type: "string" },
    accountId: { type: "string" },
    identityClaims: { type: ["object", "null"], additionalProperties: true },
    scopesGranted: { type: "array", items: { type: "string" } },
    needsReconnection: { type: "boolean" },
    expiresAt: { type: ["string", "null"], format: "date-time" },
    ownerType: { type: "string", enum: ["user", "end_user"] },
    ownerId: { type: "string" },
    label: { type: ["string", "null"] },
    sharedWithOrg: { type: "boolean" },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
} as const;

const oauthClientSchema = {
  type: "object",
  required: [
    "applicationId",
    "integrationPackageId",
    "authKey",
    "clientId",
    "hasClientSecret",
    "redirectUri",
    "createdAt",
    "updatedAt",
  ],
  properties: {
    applicationId: { type: "string" },
    integrationPackageId: { type: "string" },
    authKey: { type: "string" },
    clientId: { type: "string" },
    hasClientSecret: { type: "boolean" },
    redirectUri: { type: ["string", "null"] },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
} as const;

const authStatusSchema = {
  type: "object",
  required: ["authKey", "type", "required", "scopes", "audience", "connections", "hasOAuthClient"],
  properties: {
    authKey: { type: "string" },
    type: { type: "string", enum: ["oauth2", "oauth1", "api_key", "basic", "custom"] },
    required: { type: "boolean" },
    scopes: { type: "array", items: { type: "string" } },
    audience: { type: ["string", "null"] },
    connections: { type: "array", items: integrationConnectionSchema },
    hasOAuthClient: { type: "boolean" },
  },
} as const;

const integrationDetailSchema = {
  type: "object",
  required: ["manifest", "auths"],
  properties: {
    manifest: { type: "object", additionalProperties: true },
    auths: { type: "array", items: authStatusSchema },
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
        "List every AFPS integration accessible to the current org (own + system), enriched with an `installed` flag for the current application.",
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
        integrationPackageIdParam,
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
  "/api/integrations/{packageId}/install": {
    post: {
      operationId: "installIntegration",
      tags: ["Integrations"],
      summary: "Install an integration in the current application",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        integrationPackageIdParam,
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
          description: "Installed",
          headers: baseResponseHeaders,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["installed", "installedAt"],
                properties: {
                  installed: { type: "boolean" },
                  installedAt: { type: "string", format: "date-time" },
                },
              },
            },
          },
        },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": {
          description: "Already installed or wrong package type",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
      },
    },
    delete: {
      operationId: "uninstallIntegration",
      tags: ["Integrations"],
      summary: "Uninstall an integration from the current application",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        integrationPackageIdParam,
      ],
      responses: {
        "200": {
          description: "Uninstalled",
          headers: baseResponseHeaders,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["uninstalled"],
                properties: { uninstalled: { type: "boolean" } },
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
        integrationPackageIdParam,
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
        integrationPackageIdParam,
        authKeyParam,
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["clientId"],
              properties: {
                clientId: { type: "string", minLength: 1 },
                clientSecret: { type: "string" },
                redirectUri: { type: "string", format: "uri" },
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
        integrationPackageIdParam,
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
  "/api/integrations/{packageId}/auths/{authKey}/required-scopes": {
    get: {
      operationId: "getIntegrationRequiredScopes",
      tags: ["Integrations"],
      summary: "Compute the OAuth scope union the kickoff will request",
      description:
        "Returns the niveau 2 scope envelope for `(application, integration, auth)`: the manifest defaults, the dynamic union inferred from installed agents (via `tools.{name}.requiredScopes`), the actor's currently-granted scopes (high-water-mark across accounts), the strict union that the OAuth kickoff actually requests, the subset that's not yet granted (drives the incremental-consent UI), and a per-agent breakdown for the 'which agent asked for X' surface.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        integrationPackageIdParam,
        authKeyParam,
      ],
      responses: {
        "200": {
          description: "Scope envelope",
          headers: baseResponseHeaders,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: [
                  "defaults",
                  "required",
                  "granted",
                  "union",
                  "missingFromGranted",
                  "breakdown",
                ],
                properties: {
                  defaults: { type: "array", items: { type: "string" } },
                  required: { type: "array", items: { type: "string" } },
                  granted: { type: "array", items: { type: "string" } },
                  union: { type: "array", items: { type: "string" } },
                  missingFromGranted: { type: "array", items: { type: "string" } },
                  breakdown: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["agentId", "viaTools", "viaExplicit"],
                      properties: {
                        agentId: { type: "string" },
                        viaTools: { type: "array", items: { type: "string" } },
                        viaExplicit: { type: "array", items: { type: "string" } },
                      },
                    },
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
  "/api/integrations/{packageId}/auths/{authKey}/connect/fields": {
    post: {
      operationId: "connectIntegrationFields",
      tags: ["Integrations"],
      summary: "Connect an api_key / basic / custom integration auth",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        integrationPackageIdParam,
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
        integrationPackageIdParam,
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
                forceAccountSelect: { type: "boolean" },
                connectionId: { type: "string", format: "uuid" },
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
        integrationPackageIdParam,
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
  "/api/integrations/{packageId}/accessible-connections": {
    get: {
      operationId: "listAccessibleIntegrationConnections",
      tags: ["Integrations"],
      summary: "List own + shared connections the actor could pick at run-time",
      description:
        "Drives the R3 pre-run picker on agent pages — returns every connection the " +
        "caller could resolve to for this integration at run kickoff (own connections " +
        "and connections others shared with the org). Same predicate as the spawn-time " +
        "resolver's fallback step.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        integrationPackageIdParam,
      ],
      responses: {
        "200": {
          description: "Accessible connection list",
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
                      required: [
                        "id",
                        "authKey",
                        "accountId",
                        "label",
                        "ownerUserId",
                        "ownerEndUserId",
                        "ownerName",
                        "scopesGranted",
                        "sharedWithOrg",
                        "needsReconnection",
                      ],
                      properties: {
                        id: { type: "string", format: "uuid" },
                        authKey: { type: "string" },
                        accountId: { type: "string" },
                        label: { type: ["string", "null"] },
                        ownerUserId: { type: ["string", "null"] },
                        ownerEndUserId: { type: ["string", "null"] },
                        ownerName: { type: ["string", "null"] },
                        scopesGranted: { type: "array", items: { type: "string" } },
                        sharedWithOrg: { type: "boolean" },
                        needsReconnection: { type: "boolean" },
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
        integrationPackageIdParam,
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
                  "resolvedConnectionId",
                  "resolvedMissingScopes",
                  "resolvedOwnedByActor",
                  "adminPinnedConnectionId",
                  "memberPinnedConnectionId",
                  "canAddConnection",
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
                  resolvedConnectionId: { type: ["string", "null"] },
                  resolvedMissingScopes: { type: "array", items: { type: "string" } },
                  resolvedOwnedByActor: { type: "boolean" },
                  adminPinnedConnectionId: { type: ["string", "null"] },
                  memberPinnedConnectionId: { type: ["string", "null"] },
                  canAddConnection: { type: "boolean" },
                  candidates: {
                    type: "array",
                    items: {
                      type: "object",
                      required: [
                        "id",
                        "authKey",
                        "accountId",
                        "label",
                        "ownerUserId",
                        "ownerEndUserId",
                        "ownerName",
                        "scopesGranted",
                        "sharedWithOrg",
                        "needsReconnection",
                        "missingScopes",
                        "isOwn",
                      ],
                      properties: {
                        id: { type: "string", format: "uuid" },
                        authKey: { type: "string" },
                        accountId: { type: "string" },
                        label: { type: ["string", "null"] },
                        ownerUserId: { type: ["string", "null"] },
                        ownerEndUserId: { type: ["string", "null"] },
                        ownerName: { type: ["string", "null"] },
                        scopesGranted: { type: "array", items: { type: "string" } },
                        sharedWithOrg: { type: "boolean" },
                        needsReconnection: { type: "boolean" },
                        missingScopes: { type: "array", items: { type: "string" } },
                        isOwn: { type: "boolean" },
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
      summary: "Update an integration connection's label and/or sharedWithOrg flag",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        integrationPackageIdParam,
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
                sharedWithOrg: { type: "boolean" },
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
                required: ["id", "label", "sharedWithOrg", "updatedAt"],
                properties: {
                  id: { type: "string", format: "uuid" },
                  label: { type: ["string", "null"] },
                  sharedWithOrg: { type: "boolean" },
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
        integrationPackageIdParam,
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["blockUserConnections"],
              properties: { blockUserConnections: { type: "boolean" } },
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
        integrationPackageIdParam,
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
        integrationPackageIdParam,
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
                      required: ["packageId", "displayName"],
                      properties: {
                        packageId: { type: "string" },
                        displayName: { type: "string" },
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
        integrationPackageIdParam,
        agentPackageIdParam,
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["connectionId"],
              properties: { connectionId: { type: "string", format: "uuid" } },
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
        integrationPackageIdParam,
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
} as const;
