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
                      required: ["id", "content", "createdAt", "actorType"],
                      properties: {
                        id: { type: "integer" },
                        content: {},
                        createdAt: { type: "string", format: "date-time" },
                        actorType: {
                          type: "string",
                          enum: ["user", "end_user", "shared"],
                        },
                        actorId: { type: ["string", "null"] },
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
                    actorType: "user",
                    actorId: "usr_abc",
                  },
                ],
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
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
          description: "Credentials, authorized URIs, and transport metadata",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["credentials", "authorizedUris", "allowAllUris", "credentialFieldName"],
                properties: {
                  credentials: {
                    type: "object",
                    description:
                      "Credential fields keyed by name. Consumed server-side by the sidecar / credential-proxy when injecting the upstream auth header.",
                    additionalProperties: { type: "string" },
                  },
                  authorizedUris: {
                    type: ["array", "null"],
                    items: { type: "string" },
                  },
                  allowAllUris: { type: "boolean" },
                  credentialHeaderName: {
                    type: "string",
                    description:
                      "Header name the upstream expects the credential under. When present, the sidecar / credential-proxy writes this header server-side from `credentials[credentialFieldName]`.",
                  },
                  credentialHeaderPrefix: {
                    type: "string",
                    description:
                      "Optional prefix prepended to the credential value (e.g. `Bearer`).",
                  },
                  credentialFieldName: {
                    type: "string",
                    description:
                      "Name of the field in `credentials` that holds the secret. Defaults to `access_token` for OAuth flows and `api_key` for API-key flows unless the manifest overrides via `definition.credentials.fieldName`.",
                  },
                },
              },
              example: {
                credentials: { access_token: "ya29.a0AfH6SM..." },
                authorizedUris: ["https://gmail.googleapis.com/**"],
                allowAllUris: false,
                credentialHeaderName: "Authorization",
                credentialHeaderPrefix: "Bearer",
                credentialFieldName: "access_token",
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
          description: "Refreshed credentials, authorized URIs, and transport metadata",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["credentials", "authorizedUris", "allowAllUris", "credentialFieldName"],
                properties: {
                  credentials: {
                    type: "object",
                    additionalProperties: { type: "string" },
                  },
                  authorizedUris: {
                    type: ["array", "null"],
                    items: { type: "string" },
                  },
                  allowAllUris: { type: "boolean" },
                  credentialHeaderName: { type: "string" },
                  credentialHeaderPrefix: { type: "string" },
                  credentialFieldName: { type: "string" },
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
              schema: {
                type: "object",
                required: ["auths", "deliveryPlans", "expiresAtEpochMs"],
                properties: {
                  auths: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["authKey", "authType", "fields", "authorizedUris"],
                      properties: {
                        authKey: { type: "string" },
                        authType: { type: "string" },
                        fields: { type: "object", additionalProperties: { type: "string" } },
                        authorizedUris: { type: "array", items: { type: "string" } },
                        audience: { type: "string" },
                        expiresAt: { type: "string", format: "date-time" },
                        scopesGranted: { type: "array", items: { type: "string" } },
                      },
                    },
                  },
                  deliveryPlans: {
                    type: "object",
                    additionalProperties: {
                      type: "object",
                      required: ["headerName", "headerPrefix", "value", "allowServerOverride"],
                      properties: {
                        headerName: { type: "string" },
                        headerPrefix: { type: "string" },
                        value: { type: "string" },
                        allowServerOverride: { type: "boolean" },
                      },
                    },
                  },
                  expiresAtEpochMs: {
                    type: "object",
                    additionalProperties: { type: ["integer", "null"] },
                  },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": {
          description:
            "Refresh token revoked upstream — the integration connection has been flagged `needsReconnection` and the sidecar should surface this to the integration's MCP client as a 401.",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
        "404": { $ref: "#/components/responses/NotFound" },
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
              schema: {
                type: "object",
                required: ["auths", "deliveryPlans", "expiresAtEpochMs"],
                properties: {
                  auths: { type: "array", items: { type: "object" } },
                  deliveryPlans: { type: "object", additionalProperties: { type: "object" } },
                  expiresAtEpochMs: {
                    type: "object",
                    additionalProperties: { type: ["integer", "null"] },
                  },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": {
          description: "Refresh token revoked upstream — same semantics as the GET endpoint.",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/internal/integration-bundle/{scope}/{name}": {
    get: {
      operationId: "getIntegrationBundle",
      tags: ["Internal"],
      summary: "Fetch the AFPS bundle bytes for an installed integration",
      description:
        "Container-to-host only. Auth via Bearer run token. Called by the sidecar's integrations-boot to materialise the integration's MCP server before spawning a runner container. The endpoint verifies that the run's agent declares this integration in `dependencies.integrations` AND that the integration is installed on the run's application — orthogonal access control to the credentials endpoint. Returns the raw ZIP archive (`application/zip`).",
      security: [{ bearerExecToken: [] }],
      parameters: [
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
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
        "403": {
          description:
            "Agent does not declare this integration as a dependency OR the integration is not installed on this application.",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
} as const;
