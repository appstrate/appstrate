// SPDX-License-Identifier: Apache-2.0

import { STD_RESPONSE_HEADERS, REQUEST_ID_ONLY_HEADERS } from "../headers.ts";

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
        { $ref: "#/components/parameters/XSpaceId" },
      ],
      responses: {
        "200": {
          description: "Available scopes",
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
                    items: { type: "string" },
                    description: "Permission scopes the current user can assign to API keys",
                  },
                  hasMore: { type: "boolean" },
                },
              },
              example: {
                object: "list",
                hasMore: false,
                data: [
                  "agents:read",
                  "agents:run",
                  "runs:read",
                  "end-users:read",
                  "end-users:write",
                ],
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
      description:
        "List active (non-revoked) API keys for the current space (scoped by X-Space-Id).",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
      ],
      responses: {
        "200": {
          description: "API key list",
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
                    items: { $ref: "#/components/schemas/ApiKeyInfo" },
                  },
                  hasMore: { type: "boolean" },
                },
              },
              example: {
                object: "list",
                hasMore: false,
                data: [
                  {
                    id: "cm8vwx234",
                    name: "Production CI",
                    keyPrefix: "ask_prod",
                    scopes: ["agents:run", "runs:read"],
                    created_by: "user_abc",
                    created_by_name: "Jane Doe",
                    createdAt: "2026-01-10T08:00:00Z",
                    expiresAt: null,
                    lastUsedAt: "2026-01-12T10:00:00Z",
                    revokedAt: null,
                  },
                ],
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
        "Create a new API key. The raw key is returned **once** in the response and cannot be retrieved later. The key is bound to the space named by `X-Space-Id`, which must be a TEAM space: a personal space takes no keys (409 `personal_space_takes_no_keys`), because a key carries no user and so could never resolve one.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["name"],
              description: "The API key is scoped to the space specified by the X-Space-Id header.",
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
                  description: "ISO 8601 datetime. Must be in the future if provided.",
                },
                scopes: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "Permission scopes for the key (e.g. `agents:read`, `agents:run`). Omit or pass an empty array for full role access. A scope no API key can carry — unknown, or session-only such as `org:delete` — is rejected with a 400 naming it; a scope the creator's own role does not hold is dropped, since a key cannot be granted more than its creator has. `GET /api/api-keys/available-scopes` lists what the caller can grant.",
                },
              },
              additionalProperties: false,
            },
          },
        },
      },
      responses: {
        "201": {
          description: "API key created. The `key` field contains the raw key (shown only once).",
          headers: STD_RESPONSE_HEADERS,
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
              example: {
                id: "cm8vwx235",
                key: "ask_prod_k3x9m2pq7r4t1w6y0a5d8g",
                keyPrefix: "ask_prod",
                scopes: ["agents:run", "runs:read"],
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "409": {
          description:
            "The current space is a personal space (`personal_space_takes_no_keys`). API keys are team-space only.",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
        "500": { $ref: "#/components/responses/InternalServerError" },
      },
    },
  },
  "/api/api-keys/{id}": {
    delete: {
      operationId: "revokeApiKey",
      tags: ["API Keys"],
      summary: "Revoke an API key",
      description:
        "Revoke (soft-delete) an API key. The key will immediately stop working. " +
        "`api-keys:revoke` is required in the KEY's own space, not in the space the " +
        "request carries. A caller who cannot reach that space gets the space's own " +
        "wall: 404 when it is `private` (its existence must not leak through the id " +
        "of a key inside it), 403 `not_a_space_member` when it is `open` or " +
        "`closed`. An API-key caller reaching for a key of another space always " +
        "answers 404 — a key delegates authority in exactly one space.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "204": {
          description: "API key revoked",
          headers: REQUEST_ID_ONLY_HEADERS,
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "500": { $ref: "#/components/responses/InternalServerError" },
      },
    },
  },
} as const;
