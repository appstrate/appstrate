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

const createClientRequest = {
  type: "object",
  required: ["name", "redirectUris"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 200 },
    redirectUris: {
      type: "array",
      minItems: 1,
      items: { type: "string", format: "uri" },
    },
    scopes: { type: "array", items: { type: "string" } },
  },
};

const updateClientRequest = {
  type: "object",
  properties: {
    redirectUris: {
      type: "array",
      minItems: 1,
      items: { type: "string", format: "uri" },
    },
    disabled: { type: "boolean" },
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
        "Register a new OAuth 2.1 client for the current application. The plaintext `clientSecret` is returned exactly once in the response body.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
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
      description: "List all OAuth clients registered against the current application.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
      ],
      responses: {
        "200": {
          description: "List of OAuth clients.",
          headers: commonHeaders,
          content: {
            "application/json": {
              schema: clientListResponse,
            },
          },
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
        { $ref: "#/components/parameters/XAppId" },
        {
          name: "clientId",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
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
        "Update the redirect URIs or `disabled` flag. The client secret is NOT rotatable here — use the `/rotate` endpoint.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        {
          name: "clientId",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
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
        { $ref: "#/components/parameters/XAppId" },
        {
          name: "clientId",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
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
      description:
        "Return the canonical OAuth scope vocabulary the authorization server supports. Used by the admin UI to render the create-client scope checkbox group so the frontend never hardcodes scope strings.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
      ],
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
      description: "Issue a fresh plaintext `clientSecret`. The previous secret is invalidated.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        {
          name: "clientId",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
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
