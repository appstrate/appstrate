// SPDX-License-Identifier: Apache-2.0

export const welcomePaths = {
  "/api/welcome/setup": {
    post: {
      operationId: "welcomeSetup",
      tags: ["Welcome"],
      summary: "Post-invite profile setup",
      description: "Set display name after invitation signup.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                displayName: { type: "string", maxLength: 100 },
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
              schema: { type: "object", properties: { ok: { type: "boolean" } } },
              example: { ok: true },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
      },
    },
  },
} as const;
