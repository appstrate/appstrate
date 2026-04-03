// SPDX-License-Identifier: Apache-2.0

export const internalPaths = {
  "/internal/run-history": {
    get: {
      operationId: "getRunHistory",
      tags: ["Internal"],
      summary: "Fetch run history",
      description: "Container-to-host only. Auth via Bearer run token.",
      security: [{ bearerExecToken: [] }],
      parameters: [
        {
          name: "limit",
          in: "query",
          description: "Max number of runs to return (1-50, default 10)",
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
          description: "Run history",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  runs: { type: "array", items: { type: "object" } },
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
      description: "Container-to-host only. Auth via Bearer run token.",
      security: [{ bearerExecToken: [] }],
      parameters: [
        {
          name: "scope",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^@[a-z0-9][a-z0-9-]*$" },
        },
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
        "403": { description: "Run not running" },
        "404": { description: "Agent, provider, or binding not found" },
      },
    },
  },
  "/internal/connections/report-auth-failure": {
    post: {
      operationId: "reportAuthFailure",
      tags: ["Internal"],
      summary: "Report upstream auth failure",
      description:
        "Called by sidecar when an upstream provider returns 401. Flags the connection as needs_reconnection. Container-to-host only. Auth via Bearer run token.",
      security: [{ bearerExecToken: [] }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                providerId: {
                  type: "string",
                  description: "Provider ID that returned 401",
                },
              },
              required: ["providerId"],
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Acknowledgement",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  flagged: { type: "boolean" },
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
