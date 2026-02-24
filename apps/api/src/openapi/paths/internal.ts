export const internalPaths = {
  "/internal/execution-history": {
    get: {
      operationId: "getExecutionHistory",
      tags: ["Internal"],
      summary: "Fetch execution history",
      description: "Container-to-host only. Auth via Bearer execution token.",
      security: [{ bearerExecToken: [] }],
      responses: {
        "200": { description: "Execution history" },
        "401": { $ref: "#/components/responses/Unauthorized" },
      },
    },
  },
  "/internal/credentials/{serviceId}": {
    get: {
      operationId: "getServiceCredentials",
      tags: ["Internal"],
      summary: "Fetch service credentials",
      description: "Container-to-host only. Auth via Bearer execution token.",
      security: [{ bearerExecToken: [] }],
      parameters: [{ name: "serviceId", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        "200": {
          description: "Credentials and authorized URIs",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  credentials: { type: "object" },
                  authorizedUris: { type: "array", items: { type: "string" } },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
      },
    },
  },
} as const;
