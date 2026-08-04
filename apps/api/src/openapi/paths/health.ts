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
                  status: { type: "string", enum: ["healthy", "degraded"] },
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
                        description: "Agent runtime readiness established during platform boot.",
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
          description: "Platform unavailable while starting, draining, or unhealthy",
          content: {
            "application/json": {
              schema: {
                oneOf: [
                  {
                    type: "object",
                    properties: {
                      status: { type: "string", enum: ["starting", "draining"] },
                      version: {
                        type: "object",
                        properties: {
                          app: { type: "string" },
                          commit: { type: "string" },
                        },
                        required: ["app"],
                      },
                    },
                    required: ["status", "version"],
                  },
                  {
                    type: "object",
                    properties: {
                      status: { type: "string", enum: ["unhealthy"] },
                      version: {
                        type: "object",
                        properties: {
                          app: { type: "string" },
                          commit: { type: "string" },
                        },
                        required: ["app"],
                      },
                      uptime_ms: { type: "number" },
                      checks: { type: "object" },
                    },
                    required: ["status", "version", "uptime_ms", "checks"],
                  },
                ],
              },
              examples: {
                starting: {
                  summary: "Application boot is still in progress",
                  value: {
                    status: "starting",
                    version: { app: "v1.0.0-beta.49", commit: "5bbe1d9" },
                  },
                },
                draining: {
                  summary: "Replica has withdrawn readiness before shutdown",
                  value: {
                    status: "draining",
                    version: { app: "v1.0.0-beta.49", commit: "5bbe1d9" },
                  },
                },
                unhealthy: {
                  summary: "A critical platform dependency is unhealthy",
                  value: {
                    status: "unhealthy",
                    version: { app: "v1.0.0-beta.49", commit: "5bbe1d9" },
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
    },
  },
} as const;
