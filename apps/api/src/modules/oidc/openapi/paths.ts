// SPDX-License-Identifier: Apache-2.0

const clientListResponse = {
  type: "object",
  required: ["object", "data"],
  properties: {
    object: { type: "string", enum: ["list"] },
    data: {
      type: "array",
      items: { $ref: "#/components/schemas/OAuthClientObject" },
    },
  },
};

const orgLevelClientRequest = {
  type: "object",
  required: ["level", "name", "redirectUris", "referencedOrgId"],
  properties: {
    level: { type: "string", enum: ["org"] },
    name: { type: "string", minLength: 1, maxLength: 200 },
    redirectUris: {
      type: "array",
      minItems: 1,
      items: { type: "string", format: "uri" },
    },
    postLogoutRedirectUris: {
      type: "array",
      items: { type: "string", format: "uri" },
      description: "URIs allowed for post-logout redirects (OIDC RP-Initiated Logout).",
    },
    scopes: { type: "array", items: { type: "string" } },
    referencedOrgId: { type: "string" },
    isFirstParty: { type: "boolean" },
    allowSignup: {
      type: "boolean",
      description:
        "When `true`, users signing in for the first time through this client are auto-joined to `referencedOrgId` with `signupRole`. When `false` (default), non-members are rejected. Only meaningful for org-level clients.",
    },
    signupRole: {
      type: "string",
      enum: ["admin", "member", "viewer"],
      description:
        "Role assigned on auto-join. `owner` is deliberately excluded to prevent self-promotion via a misconfigured client. Defaults to `member`.",
    },
  },
};

const applicationLevelClientRequest = {
  type: "object",
  required: ["level", "name", "redirectUris", "referencedApplicationId"],
  properties: {
    level: { type: "string", enum: ["application"] },
    name: { type: "string", minLength: 1, maxLength: 200 },
    redirectUris: {
      type: "array",
      minItems: 1,
      items: { type: "string", format: "uri" },
    },
    postLogoutRedirectUris: {
      type: "array",
      items: { type: "string", format: "uri" },
      description: "URIs allowed for post-logout redirects (OIDC RP-Initiated Logout).",
    },
    scopes: { type: "array", items: { type: "string" } },
    referencedApplicationId: { type: "string" },
    isFirstParty: { type: "boolean" },
  },
};

const createClientRequest = {
  oneOf: [orgLevelClientRequest, applicationLevelClientRequest],
  discriminator: { propertyName: "level" },
};

const updateClientRequest = {
  type: "object",
  properties: {
    redirectUris: {
      type: "array",
      minItems: 1,
      items: { type: "string", format: "uri" },
    },
    postLogoutRedirectUris: {
      type: "array",
      items: { type: "string", format: "uri" },
      description: "URIs allowed for post-logout redirects (OIDC RP-Initiated Logout).",
    },
    scopes: {
      type: "array",
      items: { type: "string" },
      description:
        "OAuth scopes granted to this client. Must be a subset of `/api/oauth/scopes`. Existing access tokens retain the scopes they were minted with; updating this field only affects subsequent authorizations.",
    },
    disabled: { type: "boolean" },
    isFirstParty: { type: "boolean" },
    allowSignup: {
      type: "boolean",
      description:
        "Org-level only. When `true`, users signing in for the first time through this client are auto-joined to the referenced org with `signupRole`. Rejected with 400 on application/instance clients.",
    },
    signupRole: {
      type: "string",
      enum: ["admin", "member", "viewer"],
      description: "Org-level only. Role assigned on auto-join. `owner` forbidden.",
    },
  },
};

const commonHeaders = {
  "Request-Id": { $ref: "#/components/headers/RequestId" },
  "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
  RateLimit: { $ref: "#/components/headers/RateLimit" },
  "RateLimit-Policy": { $ref: "#/components/headers/RateLimitPolicy" },
};

export const oidcPaths = {
  "/api/oauth/clients": {
    post: {
      operationId: "createOAuthClient",
      tags: ["OAuth Clients"],
      summary: "Register an OAuth client",
      description:
        "Register a new OAuth 2.1 client. Polymorphic across `org` (org-scoped, dashboard users) and `application` (app-scoped, end-users) levels. The plaintext `clientSecret` is returned exactly once.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/IdempotencyKey" },
      ],
      requestBody: {
        required: true,
        content: { "application/json": { schema: createClientRequest } },
      },
      responses: {
        "201": {
          description: "OAuth client registered.",
          headers: {
            ...commonHeaders,
            "Idempotent-Replayed": { $ref: "#/components/headers/IdempotentReplayed" },
          },
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/OAuthClientWithSecret" },
            },
          },
        },
      },
    },
    get: {
      operationId: "listOAuthClients",
      tags: ["OAuth Clients"],
      summary: "List OAuth clients",
      description:
        "List every OAuth client visible to the current organization — both org-level clients pinned to the org and application-level clients pinned to any application the org owns.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      responses: {
        "200": {
          description: "List of OAuth clients.",
          headers: commonHeaders,
          content: { "application/json": { schema: clientListResponse } },
        },
      },
    },
  },
  "/api/oauth/clients/{clientId}": {
    get: {
      operationId: "getOAuthClient",
      tags: ["OAuth Clients"],
      summary: "Get OAuth client",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "clientId", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "OAuth client detail.",
          headers: commonHeaders,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/OAuthClientObject" },
            },
          },
        },
        "404": { description: "Client not found." },
      },
    },
    patch: {
      operationId: "updateOAuthClient",
      tags: ["OAuth Clients"],
      summary: "Update OAuth client",
      description:
        "Update the redirect URIs, post-logout redirect URIs, scopes, `disabled` flag, or `isFirstParty` flag. Client type and pinned references are immutable.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "clientId", in: "path", required: true, schema: { type: "string" } },
      ],
      requestBody: {
        required: true,
        content: { "application/json": { schema: updateClientRequest } },
      },
      responses: {
        "200": {
          description: "Client updated.",
          headers: commonHeaders,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/OAuthClientObject" },
            },
          },
        },
        "404": { description: "Client not found." },
      },
    },
    delete: {
      operationId: "deleteOAuthClient",
      tags: ["OAuth Clients"],
      summary: "Delete OAuth client",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "clientId", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "204": { description: "Client deleted." },
        "404": { description: "Client not found." },
      },
    },
  },
  "/api/oauth/scopes": {
    get: {
      operationId: "listOAuthScopes",
      tags: ["OAuth Clients"],
      summary: "List supported OAuth scopes",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      responses: {
        "200": {
          description: "List of supported OAuth scopes.",
          headers: commonHeaders,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["data"],
                properties: {
                  data: { type: "array", items: { type: "string" } },
                },
              },
            },
          },
        },
      },
    },
  },
  "/api/oauth/clients/{clientId}/rotate": {
    post: {
      operationId: "rotateOAuthClientSecret",
      tags: ["OAuth Clients"],
      summary: "Rotate client secret",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "clientId", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "Client secret rotated.",
          headers: commonHeaders,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/OAuthClientWithSecret" },
            },
          },
        },
        "404": { description: "Client not found." },
      },
    },
  },
};
