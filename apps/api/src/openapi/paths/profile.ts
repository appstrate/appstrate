// SPDX-License-Identifier: Apache-2.0

export const profilePaths = {
  "/api/profile": {
    get: {
      operationId: "getProfile",
      tags: ["Profile"],
      summary: "Get user profile",
      description: "Get the current user's profile (email, name, display_name, language).",
      responses: {
        "200": {
          description: "User profile",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/UserProfile" },
              example: {
                id: "usr_abc123",
                displayName: "Alice Martin",
                language: "fr",
                email: "alice@example.com",
                name: "Alice Martin",
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    patch: {
      operationId: "updateProfile",
      tags: ["Profile"],
      summary: "Update user profile",
      description: "Update the current user's profile (displayName, language).",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                displayName: { type: "string", minLength: 1, maxLength: 100 },
                language: { type: "string", enum: ["fr", "en"] },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Updated profile — same serializer as GET /api/profile",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/UserProfile" },
              example: {
                id: "usr_abc123",
                displayName: "Alice Martin",
                language: "en",
                email: "alice@example.com",
                name: "Alice Martin",
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "500": { $ref: "#/components/responses/InternalServerError" },
      },
    },
  },
  "/api/profiles/batch": {
    post: {
      operationId: "batchGetProfiles",
      tags: ["Profile"],
      summary: "Batch lookup profiles",
      description: "Retrieve display names for a list of user IDs.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["ids"],
              properties: {
                ids: { type: "array", items: { type: "string" }, maxItems: 100 },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Profiles",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
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
                    items: { $ref: "#/components/schemas/ProfileBatchItem" },
                  },
                  hasMore: { type: "boolean" },
                },
              },
              example: {
                object: "list",
                hasMore: false,
                data: [
                  { id: "usr_abc123", displayName: "Alice Martin" },
                  { id: "usr_def456", displayName: "Bob Dupont" },
                ],
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
      },
    },
  },
} as const;
