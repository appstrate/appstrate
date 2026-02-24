export const healthPaths = {
  "/health": {
    get: {
      operationId: "getHealth",
      tags: ["Health"],
      summary: "Health check",
      description: "Returns platform health status. No authentication required.",
      security: [],
      responses: {
        "200": {
          description: "Platform healthy or degraded",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  status: { type: "string", enum: ["healthy", "degraded"] },
                  uptime_ms: { type: "number" },
                  checks: {
                    type: "object",
                    properties: {
                      database: { type: "string" },
                      flows: { type: "string" },
                    },
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
