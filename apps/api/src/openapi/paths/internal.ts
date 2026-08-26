// SPDX-License-Identifier: Apache-2.0

/**
 * The `409` answered by BOTH `/internal/integration-credentials/{scope}/{name}`
 * operations. Module-local const, NOT a `#/components/responses/*` $ref: the same
 * object is serialized at both sites, so the emitted spec stays byte-identical to
 * the hand-written pair it replaces. Same technique as `paths/files.ts`'s
 * `pipelineResponses`.
 */
const integrationCredentialsConflict409 = {
  description:
    "The definition this run executes is no longer readable, so the run token's authorization set cannot be decided. Two distinct causes, told apart by the problem `code`: `run_definition_gone` — the `package_versions` snapshot pinned by `runs.version_ref` was deleted while the run was in flight (the agent row is still there; re-publishing that version restores it); `run_agent_deleted` — the agent package itself was deleted mid-run (`runs.package_id` is `ON DELETE SET NULL`, so the run survives for observability) and nothing will restore that definition. There is deliberately no draft fallback in either case: the run's authorization set may never be re-derived from the mutable draft. Both are `409`, not `410`, which on this endpoint means the credential was revoked upstream, and not `404`, which here means the integration is not a dependency of the running agent or not installed. A third cause shares the status on this endpoint: `integration_auth_undeclared` — the integration manifest VERSION frozen for this run (`runs.resolved_integration_versions`) does not declare the `auth_key` the run's connection was created against (the auth was renamed or removed after the connection was made). Nothing can be injected without that declaration, and the credential is deliberately NOT flagged `needsReconnection`: it is intact and may still be valid under another manifest version, so `410` would both mislabel it and destroy a working connection over a manifest edit.",
  content: {
    "application/problem+json": {
      schema: { $ref: "#/components/schemas/ProblemDetail" },
    },
  },
} as const;

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
        "Sidecar-only. Auth via Bearer run token. Backs the MITM `MitmCredentialSource.current()` + `.deliveryPlans()` calls — returns per-auth resolved credentials + `HttpDeliveryPlan` derived from the integration's `manifest.auths.{key}.delivery.http` declaration. OAuth2 tokens are proactively refreshed when within `OAUTH_REFRESH_LEAD_MS` of expiry. Verifies that the run's agent declares this integration in `dependencies.integrations` AND that the integration is installed on the run's application. A `200` with an EMPTY `auths` array means one thing only: the integration declares no auth. Every state where a credential was expected but could not be produced fails instead — `404` when the actor has no connection (or the connection this run pinned at kickoff was deleted/unshared since), `409` when the pinned manifest version no longer declares the connection's auth, `410` when the credential is dead. The sidecar reads an empty payload as *no `delivery.http` auths, skip the MITM listener*, so answering `200` for a broken state boots the run with zero credentials and every upstream call leaves uncredentialed.",
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
        "409": integrationCredentialsConflict409,
        "410": {
          description:
            "The credential is dead and the integration connection has been flagged `needsReconnection`. Three causes, all terminal: the refresh token was revoked upstream; a forced refresh hit an auth that can never be refreshed (no OAuth client / token endpoint, or a non-OAuth auth); or the stored credentials could not be decrypted at all (rotated `CONNECTION_ENCRYPTION_KEY`, corrupted blob) — which is terminal on the plain read too, not only on a forced refresh. The sidecar stops retrying and surfaces this to the integration's MCP client as a 401; the run's `metadata.degraded_integrations[]` is stamped so the finished run shows a reconnect banner. Matches the model-provider token endpoint's revoked semantics.",
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
        "409": integrationCredentialsConflict409,
        "410": {
          description:
            "The credential is dead and the connection has been flagged `needsReconnection` — same semantics and same three causes as the GET endpoint.",
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
        "Container-to-host only. Auth via Bearer run token. Called by the sidecar's integrations-boot to materialise an integration's MCP server before spawning a runner container. In AFPS a local-source integration references a SEPARATE mcp-server package via `source.server.name`; this endpoint serves that package's bundle. It verifies that the run's agent declares an installed integration (in `dependencies.integrations`) that references this mcp-server — orthogonal access control to the credentials endpoint. Returns the raw ZIP archive (`application/zip`). The sidecar passes `?version=` with the concrete version the spawn resolver pinned from `source.server.version` (#588) so the bytes match the manifest the resolver read. It is omitted for system mcp-servers, which have no `package_versions` row to pin: their bytes are served from the in-memory boot registry by id alone. For any other mcp-server `?version=` is mandatory — omitting it is a 400, never a fallback to the newest published version (that fallback is the manifest/bytes skew #588 closed).",
      security: [{ bearerExecToken: [] }],
      parameters: [
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
        {
          name: "version",
          in: "query",
          required: false,
          description:
            "Concrete published version to serve (the version the spawn resolver pinned from `source.server.version`). Required for every mcp-server backed by a `package_versions` row; omitted only for system mcp-servers, which are served from the in-memory boot registry by id alone.",
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
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": {
          description:
            "Agent does not reference this mcp-server through an installed integration, or the requested `?version=` does not exist.",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
        "409": {
          description:
            "The definition this run executes is no longer readable, so the dependency set that authorises this fetch cannot be enumerated — and is never re-derived from the mutable draft. Two distinct causes, told apart by the problem `code`: `run_definition_gone` (the `package_versions` snapshot pinned by `runs.version_ref` was deleted while the run was in flight) and `run_agent_deleted` (the agent package itself was deleted mid-run).",
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
