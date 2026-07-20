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
          description:
            'Comma-separated fields to include: "checkpoint", "result" (default: "checkpoint")',
          schema: { type: "string", default: "checkpoint" },
        },
      ],
      responses: {
        "200": {
          description: "Run history",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["object", "data", "hasMore"],
                properties: {
                  object: { type: "string", enum: ["list"] },
                  data: { type: "array", items: { type: "object" } },
                  hasMore: { type: "boolean" },
                },
              },
              example: {
                object: "list",
                hasMore: false,
                data: [
                  {
                    id: "run_cm9abc123",
                    status: "success",
                    checkpoint: { lastProcessedId: 42 },
                    date: "2026-01-14T09:00:00Z",
                    duration: 1234,
                  },
                ],
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "500": { $ref: "#/components/responses/InternalServerError" },
      },
    },
  },
  "/internal/memories": {
    get: {
      operationId: "recallMemories",
      tags: ["Internal"],
      summary: "Recall archive memories",
      description:
        "Backs the agent-facing `recall_memory` MCP tool. Returns archive memories (pinned=false) visible to the run's actor, optionally filtered by an ILIKE substring match against content. Pinned memories are NOT returned — they are already injected into the system prompt. Container-to-host only. Auth via Bearer run token.",
      security: [{ bearerExecToken: [] }],
      parameters: [
        {
          name: "q",
          in: "query",
          description:
            "Optional case-insensitive substring filter on memory content. Empty / absent returns the most recent archive memories.",
          schema: { type: "string" },
        },
        {
          name: "limit",
          in: "query",
          description: "Max number of memories to return (1-50, default 10).",
          schema: { type: "integer", default: 10 },
        },
      ],
      responses: {
        "200": {
          description: "Recalled memories",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["memories"],
                properties: {
                  memories: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["id", "content", "createdAt", "actor_type"],
                      properties: {
                        id: { type: "integer" },
                        content: {},
                        createdAt: { type: "string", format: "date-time" },
                        actor_type: {
                          type: "string",
                          enum: ["user", "end_user", "shared"],
                        },
                        actor_id: { type: ["string", "null"] },
                      },
                    },
                  },
                },
              },
              example: {
                memories: [
                  {
                    id: 42,
                    content: "User prefers Python over JS for data tasks",
                    createdAt: "2026-04-20T10:00:00Z",
                    actor_type: "user",
                    actor_id: "usr_abc",
                  },
                ],
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "500": { $ref: "#/components/responses/InternalServerError" },
      },
    },
  },
  "/internal/oauth-token/{credentialId}": {
    get: {
      operationId: "getOAuthModelProviderToken",
      tags: ["Internal"],
      summary: "Fetch a fresh access token for an OAuth model provider connection",
      description:
        "Sidecar-only. Auth via Bearer run token. Returns the resolved access token plus the runtime config (apiShape, baseUrl, accountId, …). Refreshes the token proactively if it expires within 5 minutes.",
      security: [{ bearerExecToken: [] }],
      parameters: [
        {
          name: "credentialId",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
          description: "model_provider_credentials.id of the OAuth-backed credential.",
        },
      ],
      responses: {
        "200": {
          description: "Resolved token and runtime config.",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/OAuthTokenResponse" },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "410": {
          description:
            "Connection needs reconnection (refresh token revoked or missing). Sidecar should propagate as 401 to the agent.",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
      },
    },
  },
  "/internal/oauth-token/{credentialId}/refresh": {
    post: {
      operationId: "refreshOAuthModelProviderToken",
      tags: ["Internal"],
      summary: "Force a refresh of the access token for an OAuth model provider connection",
      description:
        "Sidecar-only. Auth via Bearer run token. Forces a refresh regardless of expiry; on revoked refresh tokens, flips needsReconnection=true on the connection and returns 410.",
      security: [{ bearerExecToken: [] }],
      parameters: [
        {
          name: "credentialId",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      responses: {
        "200": {
          description: "Refreshed token and runtime config (same shape as GET).",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/OAuthTokenResponse" },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "410": {
          description: "Refresh token revoked — connection flagged needsReconnection.",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
      },
    },
  },
  "/internal/integration-credentials/{scope}/{name}": {
    get: {
      operationId: "getIntegrationCredentials",
      tags: ["Internal"],
      summary: "Fetch live credentials + HTTP delivery plans for an installed integration",
      description:
        "Sidecar-only. Auth via Bearer run token. Backs the MITM `MitmCredentialSource.current()` + `.deliveryPlans()` calls — returns per-auth resolved credentials + `HttpDeliveryPlan` derived from the integration's `manifest.auths.{key}.delivery.http` declaration. OAuth2 tokens are proactively refreshed when within `OAUTH_REFRESH_LEAD_MS` of expiry. Verifies that the run's agent declares this integration in `dependencies.integrations` AND that the integration is installed on the run's application.",
      security: [{ bearerExecToken: [] }],
      parameters: [
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
      ],
      responses: {
        "200": {
          description: "Live credentials + delivery plans + per-auth expiries.",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/IntegrationCredentialsResponse" },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "410": {
          description:
            "Refresh token revoked upstream — the integration connection has been flagged `needsReconnection` and the sidecar should surface this to the integration's MCP client as a 401. Matches the model-provider token endpoint's revoked semantics.",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
        "502": {
          description:
            "Transient OAuth refresh failure upstream (network error, IdP 5xx, malformed response). The cached credential may still be valid; the sidecar's listener cooldown will back off and retry on the next 401.",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
        "500": { $ref: "#/components/responses/InternalServerError" },
      },
    },
  },
  "/internal/integration-credentials/{scope}/{name}/refresh": {
    post: {
      operationId: "refreshIntegrationCredentials",
      tags: ["Internal"],
      summary: "Force-refresh OAuth2 credentials for an installed integration",
      description:
        "Sidecar-only. Same response shape as the GET endpoint; forces a refresh of every OAuth2 auth on this integration regardless of remaining token lifetime. Called by the MITM listener's `refreshOnUnauthorized` hook when upstream returns 401. Non-OAuth2 auths are returned unchanged.",
      security: [{ bearerExecToken: [] }],
      parameters: [
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
      ],
      responses: {
        "200": {
          description: "Refreshed credentials + delivery plans + per-auth expiries.",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/IntegrationCredentialsResponse" },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "410": {
          description: "Refresh token revoked upstream — same semantics as the GET endpoint.",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
        "502": {
          description:
            "Transient OAuth refresh failure upstream — same semantics as the GET endpoint.",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
        "500": { $ref: "#/components/responses/InternalServerError" },
      },
    },
  },
  "/internal/mcp-server-bundle/{scope}/{name}": {
    get: {
      operationId: "getMcpServerBundle",
      tags: ["Internal"],
      summary: "Fetch the AFPS bundle bytes for a referenced mcp-server package",
      description:
        "Container-to-host only. Auth via a Bearer run token, or a short-lived sidecar-only connect capability bound to one exact MCP package/source/version and application integration. Called by the sidecar's integrations-boot to materialise an integration's MCP server before spawning a runner container. In AFPS a local-source integration references a SEPARATE mcp-server package via `source.server.name`; this endpoint serves that package's bundle. For normal runs it verifies that the run's agent declares an installed integration (in `dependencies.integrations`) that references this mcp-server. Connect capabilities have no access to credentials or other internal run surfaces. Returns the raw ZIP archive (`application/zip`). The sidecar passes `?version=` with the concrete version the spawn resolver pinned from `source.server.version` (#588) so the bytes match the manifest the resolver read; absent, the latest non-yanked version is served (back-compat).",
      security: [{ bearerExecToken: [] }],
      parameters: [
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
        {
          name: "version",
          in: "query",
          required: false,
          description:
            "Concrete published version to serve (the version the spawn resolver pinned from `source.server.version`). When omitted, the latest non-yanked version is served.",
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": {
          description: "AFPS bundle bytes (ZIP).",
          content: {
            "application/zip": {
              schema: { type: "string", format: "binary" },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": {
          description:
            "The run does not reference this mcp-server through an installed integration, the connect capability scope is no longer active, or no authorized bundle version exists.",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
      },
    },
  },
} as const;
