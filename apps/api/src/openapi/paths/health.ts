// SPDX-License-Identifier: Apache-2.0

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
                  status: { type: "string", enum: ["healthy", "degraded", "unhealthy"] },
                  uptime_ms: { type: "number" },
                  checks: {
                    type: "object",
                    properties: {
                      database: {
                        type: "object",
                        properties: {
                          status: { type: "string", enum: ["healthy", "unhealthy"] },
                          latency_ms: { type: "number" },
                        },
                      },
                      agents: {
                        type: "object",
                        properties: {
                          status: { type: "string", enum: ["healthy", "degraded"] },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "503": {
          description: "Platform unhealthy (database or critical service down)",
        },
      },
    },
  },
} as const;
