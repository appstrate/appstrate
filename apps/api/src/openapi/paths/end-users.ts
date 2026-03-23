export const endUsersPaths = {
  "/api/end-users": {
    post: {
      operationId: "createEndUser",
      tags: ["End Users"],
      summary: "Create an end-user",
      description:
        "Create a new end-user within an application. At least one of name, email, or externalId should be provided for identification.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/IdempotencyKey" },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                applicationId: {
                  type: "string",
                  description:
                    "ID of the application this end-user belongs to (app_ prefix). Defaults to the organization's default application if omitted.",
                },
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
                  type: ["object", "null"],
                  description: "Arbitrary key-value metadata",
                },
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "End-user created",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
            "Idempotent-Replayed": { $ref: "#/components/headers/IdempotentReplayed" },
            RateLimit: { $ref: "#/components/headers/RateLimit" },
            "RateLimit-Policy": { $ref: "#/components/headers/RateLimitPolicy" },
            "X-RateLimit-Remaining": { $ref: "#/components/headers/XRateLimitRemaining" },
            "X-RateLimit-Reset": { $ref: "#/components/headers/XRateLimitReset" },
          },
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/EndUserObject" },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "409": { $ref: "#/components/responses/IdempotencyInProgress" },
        "422": { $ref: "#/components/responses/IdempotencyConflict" },
      },
    },
    get: {
      operationId: "listEndUsers",
      tags: ["End Users"],
      summary: "List end-users",
      description:
        "List end-users with cursor-based pagination. Filter by applicationId, externalId, or email.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        {
          name: "applicationId",
          in: "query",
          schema: { type: "string" },
          description: "Filter by application ID",
        },
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
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
            RateLimit: { $ref: "#/components/headers/RateLimit" },
            "RateLimit-Policy": { $ref: "#/components/headers/RateLimitPolicy" },
            "X-RateLimit-Remaining": { $ref: "#/components/headers/XRateLimitRemaining" },
            "X-RateLimit-Reset": { $ref: "#/components/headers/XRateLimitReset" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
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
  "/api/end-users/{id}": {
    get: {
      operationId: "getEndUser",
      tags: ["End Users"],
      summary: "Get an end-user",
      description: "Get a single end-user by ID.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "End-user detail",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/EndUserObject" },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    patch: {
      operationId: "updateEndUser",
      tags: ["End Users"],
      summary: "Update an end-user",
      description: "Update end-user name, email, externalId, or metadata.",
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
                  type: ["object", "null"],
                  description: "Arbitrary key-value metadata",
                },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "End-user updated",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/EndUserObject" },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    delete: {
      operationId: "deleteEndUser",
      tags: ["End Users"],
      summary: "Delete an end-user",
      description: "Permanently delete an end-user.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "204": {
          description: "End-user deleted",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
} as const;
