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
              example: {
                status: "healthy",
                uptime_ms: 3600000,
                checks: {
                  database: { status: "healthy", latency_ms: 2.3 },
                  agents: { status: "healthy" },
                },
              },
            },
          },
        },
        "503": {
          description: "Platform unhealthy (database or critical service down)",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  status: { type: "string", enum: ["unhealthy"] },
                  checks: { type: "object" },
                },
              },
              example: {
                status: "unhealthy",
                checks: {
                  database: { status: "unhealthy", latency_ms: null },
                  agents: { status: "healthy" },
                },
              },
            },
          },
        },
      },
    },
  },
} as const;
