export const internalPaths = {
  "/internal/execution-history": {
    get: {
      operationId: "getExecutionHistory",
      tags: ["Internal"],
      summary: "Fetch execution history",
      description: "Container-to-host only. Auth via Bearer execution token.",
      security: [{ bearerExecToken: [] }],
      parameters: [
        {
          name: "limit",
          in: "query",
          description: "Max number of executions to return (1-50, default 10)",
          schema: { type: "integer", default: 10 },
        },
        {
          name: "fields",
          in: "query",
          description: 'Comma-separated fields to include: "state", "result" (default: "state")',
          schema: { type: "string", default: "state" },
        },
      ],
      responses: {
        "200": {
          description: "Execution history",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  executions: { type: "array", items: { type: "object" } },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
      },
    },
  },
  "/internal/credentials/{scope}/{name}": {
    get: {
      operationId: "getProviderCredentials",
      tags: ["Internal"],
      summary: "Fetch provider credentials",
      description: "Container-to-host only. Auth via Bearer execution token.",
      security: [{ bearerExecToken: [] }],
      parameters: [
        { name: "scope", in: "path", required: true, schema: { type: "string" } },
        { name: "name", in: "path", required: true, schema: { type: "string" } },
      ],
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
        "403": { description: "Execution not running" },
        "404": { description: "Flow, service, or admin binding not found" },
      },
    },
  },
} as const;
