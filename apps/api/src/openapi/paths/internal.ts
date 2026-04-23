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
              example: {
                runs: [
                  {
                    id: "run_cm9abc123",
                    status: "success",
                    state: { lastProcessedId: 42 },
                    createdAt: "2026-01-14T09:00:00Z",
                  },
                ],
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
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
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
              example: {
                credentials: { access_token: "ya29.a0AfH6SM..." },
                authorizedUris: ["https://gmail.googleapis.com/**"],
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": {
          description: "Run not running",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
              example: {
                type: "about:blank",
                title: "Forbidden",
                status: 403,
                detail: "Run is not in running state",
                code: "forbidden",
                requestId: "req_jkl012",
              },
            },
          },
        },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/internal/credentials/{scope}/{name}/refresh": {
    post: {
      operationId: "refreshProviderCredentials",
      tags: ["Internal"],
      summary: "Force-refresh provider credentials",
      description:
        "Called by sidecar on upstream 401 to force an OAuth2 token refresh before retrying. If the provider is not OAuth2 or has no refresh token, returns current credentials unchanged. If the refresh itself fails, flags the connection as needs_reconnection and returns 401. Container-to-host only. Auth via Bearer run token.",
      security: [{ bearerExecToken: [] }],
      parameters: [
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
      ],
      responses: {
        "200": {
          description: "Refreshed credentials and authorized URIs",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  credentials: { type: "object" },
                  authorizedUris: { type: "array", items: { type: "string" } },
                  allowAllUris: { type: "boolean" },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/NotFound" },
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
                  minLength: 1,
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
