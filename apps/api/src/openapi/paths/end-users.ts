// SPDX-License-Identifier: Apache-2.0

import { STD_RESPONSE_HEADERS, REQUEST_ID_ONLY_HEADERS } from "../headers.ts";

export const endUsersPaths = {
  "/api/end-users": {
    post: {
      operationId: "createEndUser",
      tags: ["End Users"],
      summary: "Create an end-user",
      description:
        "Create a new end-user within a space. At least one of name, email, or externalId should be provided for identification.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        { $ref: "#/components/parameters/IdempotencyKey" },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                name: {
                  type: ["string", "null"],
                  maxLength: 200,
                  description: "Display name of the end-user",
                },
                email: {
                  type: ["string", "null"],
                  format: "email",
                  description: "Email address of the end-user",
                },
                externalId: {
                  type: ["string", "null"],
                  maxLength: 255,
                  description: "Your system's unique identifier for this end-user",
                },
                metadata: {
                  type: "object",
                  additionalProperties: {
                    type: ["string", "number", "boolean", "null"],
                    maxLength: 500,
                  },
                  description:
                    "Key-value metadata. Max 50 keys, key length 1\u201340 chars, values: string (max 500), number, boolean, or null.",
                },
              },
              additionalProperties: false,
            },
            example: {
              name: "Alice Martin",
              email: "alice@example.com",
              externalId: "usr_12345",
              metadata: { plan: "pro", region: "eu-west" },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "End-user created",
          headers: {
            ...STD_RESPONSE_HEADERS,
            "Idempotent-Replayed": { $ref: "#/components/headers/IdempotentReplayed" },
            RateLimit: { $ref: "#/components/headers/RateLimit" },
            "RateLimit-Policy": { $ref: "#/components/headers/RateLimitPolicy" },
          },
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/EndUserObject" },
              example: {
                id: "eu_cm4jkl012",
                object: "end_user",
                spaceId: "spc_2c5d8f1a-4b70-4e63-9d18-3a7f5c9e0b24",
                name: "Alice Martin",
                email: "alice@example.com",
                externalId: "usr_12345",
                metadata: { plan: "pro", region: "eu-west" },
                createdAt: "2026-01-15T10:30:00Z",
                updatedAt: "2026-01-15T10:30:00Z",
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": {
          description:
            "Conflict — either a request with the same Idempotency-Key is already being processed (idempotency_in_progress), or the externalId is already in use by another end-user in the space (external_id_taken)",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
              examples: {
                idempotencyInProgress: {
                  summary: "Idempotency-Key already being processed",
                  value: {
                    type: "https://docs.appstrate.dev/errors/idempotency-in-progress",
                    title: "Idempotency In Progress",
                    status: 409,
                    detail:
                      "A request with the same Idempotency-Key is already being processed. Please wait and retry.",
                    code: "idempotency_in_progress",
                    requestId: "req_abc123",
                  },
                },
                externalIdTaken: {
                  summary: "externalId already in use",
                  value: {
                    type: "https://docs.appstrate.dev/errors/external-id-taken",
                    title: "Conflict",
                    status: 409,
                    detail: "An end-user with this externalId already exists in the space.",
                    code: "external_id_taken",
                    requestId: "req_abc123",
                  },
                },
              },
            },
          },
        },
        "422": { $ref: "#/components/responses/IdempotencyConflict" },
        "429": { $ref: "#/components/responses/RateLimited" },
      },
    },
    get: {
      operationId: "listEndUsers",
      tags: ["End Users"],
      summary: "List end-users",
      description:
        "List end-users with cursor-based pagination. Filter by spaceId, externalId, or email.\n\n" +
        "**Pagination**: `startingAfter` and `endingBefore` are mutually exclusive — pass at most " +
        "one. Encoded via the `x-mutually-exclusive` extension below for client generators that " +
        "honour it; the server enforces the constraint at runtime regardless.",
      "x-mutually-exclusive": ["startingAfter", "endingBefore"],
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        {
          name: "externalId",
          in: "query",
          schema: { type: "string" },
          description: "Filter by external ID (exact match)",
        },
        {
          name: "email",
          in: "query",
          schema: { type: "string" },
          description: "Filter by email address (exact match)",
        },
        {
          name: "search",
          in: "query",
          schema: { type: "string" },
          description: "Case-insensitive substring match across name, email, and external ID",
        },
        {
          name: "limit",
          in: "query",
          schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
          description: "Maximum number of end-users to return",
        },
        {
          name: "startingAfter",
          in: "query",
          schema: { type: "string" },
          description: "Cursor for forward pagination (end-user ID to start after)",
        },
        {
          name: "endingBefore",
          in: "query",
          schema: { type: "string" },
          description: "Cursor for backward pagination (end-user ID to end before)",
        },
      ],
      responses: {
        "200": {
          description: "Paginated end-user list",
          headers: {
            ...STD_RESPONSE_HEADERS,
            RateLimit: { $ref: "#/components/headers/RateLimit" },
            "RateLimit-Policy": { $ref: "#/components/headers/RateLimitPolicy" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["object", "data", "hasMore"],
                properties: {
                  object: { type: "string", enum: ["list"] },
                  data: {
                    type: "array",
                    items: { $ref: "#/components/schemas/EndUserObject" },
                  },
                  hasMore: {
                    type: "boolean",
                    description: "Whether more results exist beyond this page",
                  },
                  limit: {
                    type: "integer",
                    description: "The limit that was applied to this query",
                  },
                },
              },
              example: {
                object: "list",
                data: [
                  {
                    id: "eu_cm4jkl012",
                    object: "end_user",
                    spaceId: "spc_2c5d8f1a-4b70-4e63-9d18-3a7f5c9e0b24",
                    name: "Alice Martin",
                    email: "alice@example.com",
                    externalId: "usr_12345",
                    metadata: { plan: "pro" },
                    createdAt: "2026-01-15T10:30:00Z",
                    updatedAt: "2026-01-15T10:30:00Z",
                  },
                ],
                hasMore: false,
                limit: 20,
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "429": { $ref: "#/components/responses/RateLimited" },
      },
    },
  },
  "/api/end-users/{id}": {
    get: {
      operationId: "getEndUser",
      tags: ["End Users"],
      summary: "Get an end-user",
      description: "Get a single end-user by ID.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "End-user detail",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/EndUserObject" },
              example: {
                id: "eu_cm4jkl012",
                object: "end_user",
                spaceId: "spc_2c5d8f1a-4b70-4e63-9d18-3a7f5c9e0b24",
                name: "Alice Martin",
                email: "alice@example.com",
                externalId: "usr_12345",
                metadata: { plan: "pro", region: "eu-west" },
                createdAt: "2026-01-15T10:30:00Z",
                updatedAt: "2026-01-15T10:30:00Z",
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "429": { $ref: "#/components/responses/RateLimited" },
      },
    },
    patch: {
      operationId: "updateEndUser",
      tags: ["End Users"],
      summary: "Update an end-user",
      description: "Update end-user name, email, externalId, or metadata.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                name: {
                  type: ["string", "null"],
                  maxLength: 200,
                  description: "Display name of the end-user",
                },
                email: {
                  type: ["string", "null"],
                  format: "email",
                  description: "Email address of the end-user",
                },
                externalId: {
                  type: ["string", "null"],
                  maxLength: 255,
                  description: "Your system's unique identifier for this end-user",
                },
                metadata: {
                  type: "object",
                  additionalProperties: {
                    type: ["string", "number", "boolean", "null"],
                    maxLength: 500,
                  },
                  description:
                    "Key-value metadata. Max 50 keys, key length 1\u201340 chars, values: string (max 500), number, boolean, or null.",
                },
              },
              additionalProperties: false,
            },
          },
        },
      },
      responses: {
        "200": {
          description: "End-user updated",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/EndUserObject" },
              example: {
                id: "eu_cm4jkl012",
                object: "end_user",
                spaceId: "spc_2c5d8f1a-4b70-4e63-9d18-3a7f5c9e0b24",
                name: "Alice Martin Updated",
                email: "alice@example.com",
                externalId: "usr_12345",
                metadata: { plan: "enterprise", region: "eu-west" },
                createdAt: "2026-01-15T10:30:00Z",
                updatedAt: "2026-01-20T14:00:00Z",
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": {
          description: "The externalId is already in use by another end-user in the space",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
              example: {
                type: "https://docs.appstrate.dev/errors/external-id-taken",
                title: "Conflict",
                status: 409,
                detail: "An end-user with this externalId already exists in the space.",
                code: "external_id_taken",
                requestId: "req_abc123",
              },
            },
          },
        },
        "429": { $ref: "#/components/responses/RateLimited" },
      },
    },
    delete: {
      operationId: "deleteEndUser",
      tags: ["End Users"],
      summary: "Delete an end-user",
      description: "Permanently delete an end-user.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "204": {
          description: "End-user deleted",
          headers: REQUEST_ID_ONLY_HEADERS,
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "429": { $ref: "#/components/responses/RateLimited" },
      },
    },
  },
} as const;
