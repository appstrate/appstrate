export const profilePaths = {
  "/api/profile": {
    get: {
      operationId: "getProfile",
      tags: ["Profile"],
      summary: "Get user profile",
      description: "Get the current user's profile (displayName, language).",
      responses: {
        "200": {
          description: "User profile",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Profile" },
            },
          },
        },
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
                displayName: { type: "string" },
                language: { type: "string", enum: ["fr", "en"] },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Profile updated",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Profile" },
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
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["userIds"],
              properties: {
                userIds: { type: "array", items: { type: "string" } },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Profiles",
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
            },
          },
        },
      },
    },
  },
} as const;
