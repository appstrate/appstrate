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
                  version: {
                    type: "object",
                    properties: {
                      app: { type: "string" },
                      commit: { type: "string" },
                    },
                    required: ["app"],
                  },
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
                version: { app: "v1.0.0-beta.38", commit: "5bbe1d9" },
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
                  uptime_ms: { type: "number" },
                  checks: { type: "object" },
                },
              },
              example: {
                status: "unhealthy",
                uptime_ms: 3600000,
                checks: {
                  database: { status: "unhealthy", latency_ms: 5000 },
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
