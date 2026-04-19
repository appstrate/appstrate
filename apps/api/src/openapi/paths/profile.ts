// SPDX-License-Identifier: Apache-2.0

export const profilePaths = {
  "/api/profile": {
    get: {
      operationId: "getProfile",
      tags: ["Profile"],
      summary: "Get user profile",
      description: "Get the current user's profile (email, display_name, language).",
      responses: {
        "200": {
          description: "User profile",
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
                  displayName: { type: "string" },
                  language: { type: "string", enum: ["fr", "en"] },
                  email: { type: "string", format: "email" },
                },
              },
              example: {
                id: "usr_abc123",
                displayName: "Alice Martin",
                language: "fr",
                email: "alice@example.com",
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
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
          description: "Profile updated",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  ok: { type: "boolean" },
                  language: { type: "string", enum: ["fr", "en"] },
                  displayName: { type: "string" },
                },
              },
              example: { ok: true, language: "en", displayName: "Alice Martin" },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
      },
    },
  },
  "/api/profiles/batch": {
    post: {
      operationId: "batchGetProfiles",
      tags: ["Profile"],
      summary: "Batch lookup profiles",
      description: "Retrieve display names for a list of user IDs.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["ids"],
              properties: {
                ids: { type: "array", items: { type: "string" } },
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
                properties: {
                  profiles: {
                    type: "array",
                    items: { $ref: "#/components/schemas/ProfileBatchItem" },
                  },
                },
              },
              example: {
                profiles: [
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
