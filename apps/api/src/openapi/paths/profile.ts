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
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "500": { $ref: "#/components/responses/InternalServerError" },
      },
    },
  },
  "/api/profile/password": {
    post: {
      operationId: "setProfilePassword",
      tags: ["Profile"],
      summary: "Set an initial password",
      description:
        "Set a password for the current user when none exists yet (account created via social sign-in). " +
        "Creates the email/password credential so the user can also sign in with email. " +
        "Fails with 409 when a password is already set — use the Better Auth change-password flow instead. " +
        "Session authentication only; API keys are rejected.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["newPassword"],
              properties: {
                newPassword: { type: "string", minLength: 8, maxLength: 128 },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Password set — the credential account was created",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["status"],
                properties: {
                  status: { type: "boolean" },
                },
              },
              example: { status: true },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "409": {
          description: "Conflict — a password is already set for this account",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
              example: {
                type: "https://docs.appstrate.dev/errors/password-already-set",
                title: "Conflict",
                status: 409,
                detail:
                  "A password is already set for this account. Use the change password form instead.",
                code: "password_already_set",
                requestId: "req_abc123",
              },
            },
          },
        },
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
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
      },
    },
  },
} as const;
