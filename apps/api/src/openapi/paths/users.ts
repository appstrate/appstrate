export const usersPaths = {
  "/api/users": {
    post: {
      operationId: "createUser",
      tags: ["Users"],
      summary: "Create a user",
      description:
        "Create a user via API (source: api, no password). Automatically added as member of the org with a default connection profile. Admin only.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      requestBody: {
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                name: { type: "string", description: "Display name" },
                email: { type: "string", format: "email", description: "Email address" },
                externalId: {
                  type: "string",
                  description: "External ID for mapping to your own user system (unique per org)",
                },
                metadata: {
                  type: "object",
                  description:
                    "Key-value metadata (max 50 keys, key max 40 chars, value max 500 chars, string values only)",
                  additionalProperties: { type: "string" },
                },
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "User created",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/UserObject" },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "409": { description: "externalId or email already in use" },
      },
    },
    get: {
      operationId: "listUsers",
      tags: ["Users"],
      summary: "List users",
      description:
        "List users in the organization with cursor-based pagination. Supports filtering by externalId and email. Admin only.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        {
          name: "limit",
          in: "query",
          schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        },
        {
          name: "startingAfter",
          in: "query",
          schema: { type: "string" },
          description: "Cursor: return users after this ID",
        },
        {
          name: "endingBefore",
          in: "query",
          schema: { type: "string" },
          description: "Cursor: return users before this ID",
        },
        {
          name: "externalId",
          in: "query",
          schema: { type: "string" },
          description: "Filter by externalId",
        },
        { name: "email", in: "query", schema: { type: "string" }, description: "Filter by email" },
      ],
      responses: {
        "200": {
          description: "User list",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  object: { type: "string", enum: ["list"] },
                  data: { type: "array", items: { $ref: "#/components/schemas/UserObject" } },
                  hasMore: { type: "boolean" },
                  limit: { type: "integer" },
                },
              },
            },
          },
        },
      },
    },
  },
  "/api/users/{id}": {
    get: {
      operationId: "getUser",
      tags: ["Users"],
      summary: "Get a user",
      description: "Get a single user by ID. Admin only.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "User detail",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/UserObject" },
            },
          },
        },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    patch: {
      operationId: "updateUser",
      tags: ["Users"],
      summary: "Update a user",
      description:
        "Update user fields. Metadata is merged (existing keys preserved, new keys added). Admin only.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      requestBody: {
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                name: { type: "string" },
                email: { type: "string", format: "email" },
                externalId: { type: ["string", "null"] },
                metadata: { type: "object", additionalProperties: { type: "string" } },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "User updated",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/UserObject" },
            },
          },
        },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": { description: "externalId or email already in use" },
      },
    },
    delete: {
      operationId: "deleteUser",
      tags: ["Users"],
      summary: "Delete a user",
      description: "Delete a user and all associated data (connections, profiles). Admin only.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "204": { description: "User deleted" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
} as const;
