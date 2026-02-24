export const welcomePaths = {
  "/api/welcome/setup": {
    post: {
      operationId: "welcomeSetup",
      tags: ["Welcome"],
      summary: "Post-invite profile setup",
      description: "Set display name and/or password after invitation signup.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                displayName: { type: "string" },
                password: { type: "string", minLength: 8 },
              },
            },
          },
        },
      },
      responses: {
        "200": { description: "Profile updated" },
      },
    },
  },
} as const;
