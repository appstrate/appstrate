// SPDX-License-Identifier: Apache-2.0

export const apiKeysPaths = {
  "/api/api-keys/available-scopes": {
    get: {
      operationId: "listAvailableScopes",
      tags: ["API Keys"],
      summary: "List available scopes",
      description:
        "List permission scopes available for API key creation, based on the current user's role.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
      ],
      responses: {
        "200": {
          description: "Available scopes",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  scopes: {
                    type: "array",
                    items: { type: "string" },
                    description: "Permission scopes the current user can assign to API keys",
                  },
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
  "/api/api-keys": {
    get: {
      operationId: "listApiKeys",
      tags: ["API Keys"],
      summary: "List API keys",
      description: "List active (non-revoked) API keys for the organization.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
      ],
      responses: {
        "200": {
          description: "API key list",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  apiKeys: {
                    type: "array",
                    items: { $ref: "#/components/schemas/ApiKeyInfo" },
                  },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
    post: {
      operationId: "createApiKey",
      tags: ["API Keys"],
      summary: "Create an API key",
      description:
        "Create a new API key. The raw key is returned **once** in the response and cannot be retrieved later.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["name"],
              description:
                "The API key is scoped to the application specified by the X-App-Id header.",
              properties: {
                name: {
                  type: "string",
                  minLength: 1,
                  maxLength: 100,
                  description: "Human-readable label for the key",
                },
                expiresAt: {
                  type: ["string", "null"],
                  format: "date-time",
                  description:
                    "Expiration date (must be in the future). Null or omitted for a key that never expires.",
                },
                scopes: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "Permission scopes for the key (e.g. `agents:read`, `agents:run`). Omit or pass empty array for full role access. Invalid or unauthorized scopes are silently filtered.",
                },
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "API key created. The `key` field contains the raw key (shown only once).",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  key: {
                    type: "string",
                    description:
                      "Raw API key (prefix: ask_). Store it securely — it will not be shown again.",
                  },
                  keyPrefix: {
                    type: "string",
                    description: "First 8 characters for identification",
                  },
                  scopes: {
                    type: "array",
                    items: { type: "string" },
                    description: "Validated scopes granted to the key. Empty = full role access.",
                  },
                },
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
  },
  "/api/api-keys/{id}": {
    delete: {
      operationId: "revokeApiKey",
      tags: ["API Keys"],
      summary: "Revoke an API key",
      description: "Revoke (soft-delete) an API key. The key will immediately stop working.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "204": {
          description: "API key revoked",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { description: "API key not found or already revoked" },
      },
    },
  },
} as const;
