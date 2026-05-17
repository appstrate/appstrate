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

const integrationSummarySchema = {
  type: "object",
  required: ["id", "manifest", "orgId", "source"],
  properties: {
    id: { type: "string" },
    manifest: { type: "object", additionalProperties: true },
    orgId: { type: ["string", "null"] },
    source: { type: "string", enum: ["local", "system"] },
    installed: { type: "boolean" },
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
  "/api/integrations/installed": {
    get: {
      operationId: "listInstalledIntegrations",
      tags: ["Integrations"],
      summary: "List installed integrations for the current application",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
      ],
      responses: {
        "200": {
          description: "Installed integration list",
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
  "/api/integrations/{packageId}/connections/{connectionId}": {
    delete: {
      operationId: "disconnectIntegrationConnection",
      tags: ["Integrations"],
      summary: "Disconnect a single integration connection",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        integrationPackageIdParam,
        connectionIdParam,
      ],
      responses: {
        "200": {
          description: "Disconnected",
          headers: baseResponseHeaders,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["disconnected"],
                properties: { disconnected: { type: "boolean" } },
              },
            },
          },
        },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
} as const;
