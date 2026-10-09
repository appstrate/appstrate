// SPDX-License-Identifier: Apache-2.0

import { MAX_CONNECTIONS_PER_INTEGRATION } from "@appstrate/core/integration";
import { CREDENTIAL_FAILURE_CAUSES } from "@appstrate/core/sidecar-types";
import { CREDENTIAL_FAILURE_SENTENCES } from "../../lib/credential-failure.ts";

/** A credential endpoint's `410`/`502`: a problem whose `cause` member says why. */
function credentialFailure(description: string) {
  const causes = CREDENTIAL_FAILURE_CAUSES.map(
    (c) => `\`${c}\`: ${CREDENTIAL_FAILURE_SENTENCES[c]}.`,
  );
  return {
    description,
    content: {
      "application/problem+json": {
        schema: {
          allOf: [
            { $ref: "#/components/schemas/ProblemDetail" },
            {
              type: "object",
              required: ["cause"],
              properties: {
                cause: {
                  type: "string",
                  enum: [...CREDENTIAL_FAILURE_CAUSES],
                  description: `Why the platform did not hand back a refreshed credential. ${causes.join(" ")}`,
                },
              },
            },
          ],
        },
      },
    },
  };
}

const OAUTH_TOKEN_410 = credentialFailure(
  "`oauth_connection_needs_reconnection`: the credential is flagged `needsReconnection`. The sidecar propagates it to the agent as a 401.",
);

const OAUTH_TOKEN_502 = credentialFailure("Not refreshed now; the credential stays usable.");

/**
 * The `409` shared by the `/internal/integration-credentials/{scope}/{name}`
 * operations. Module-local const, NOT a `#/components/responses/*` $ref: the same
 * object is serialized at both sites. Same technique as `paths/files.ts`'s
 * `pipelineResponses`.
 *
 * The `/refresh` operation spreads this and EXTENDS the description with one
 * more code that only it can answer (`connect_run_no_refresh`) — the two are
 * therefore no longer byte-identical, deliberately: a shared description that
 * enumerated a code the GET never returns would be worse than a divergent one.
 */
const integrationCredentialsConflict409 = {
  description:
    "The definition this run executes is no longer readable, so the run token's authorization set cannot be decided. Two distinct causes, told apart by the problem `code`: `run_definition_gone` — the `package_versions` snapshot pinned by `runs.version_ref` was deleted while the run was in flight (the agent row is still there; re-publishing that version restores it); `run_agent_deleted` — the agent package itself was deleted mid-run (`runs.package_id` is `ON DELETE SET NULL`, so the run survives for observability) and nothing will restore that definition. There is deliberately no draft fallback in either case: the run's authorization set may never be re-derived from the mutable draft. Both are `409`, not `410`, which on this endpoint means the credential was revoked upstream, and not `404`, which here means the integration is not a dependency of the running agent or not active in the space. A third cause shares the status on this endpoint: `integration_auth_undeclared` — the integration manifest VERSION frozen for this run (`runs.resolved_integration_versions`) does not declare the `auth_key` the run's connection was created against (the auth was renamed or removed after the connection was made). Nothing can be injected without that declaration, and the credential is deliberately NOT flagged `needsReconnection`: it is intact and may still be valid under another manifest version, so `410` would both mislabel it and destroy a working connection over a manifest edit.",
  content: {
    "application/problem+json": {
      schema: { $ref: "#/components/schemas/ProblemDetail" },
    },
  },
} as const;

/**
 * `connection_id` — the selector every agent run sends to both integration-credentials
 * operations. A run binds a SET of connections to an integration
 * (`runs.resolved_connections`) and the sidecar runs one credentials source per
 * spawn spec, i.e. per connection, so an agent run always names one.
 */
const connectionIdParam = {
  name: "connection_id",
  in: "query",
  required: false,
  description:
    "Which of the connections this run bound to the integration the credentials are for. REQUIRED on an agent run (a connect run omits it): a run may bind up to " +
    MAX_CONNECTIONS_PER_INTEGRATION +
    ' connections per integration and each has its own credential surface, so there is no "the connection of this integration" to fall back to. Must be a member of `runs.resolved_connections[<integration id>]` — an id the run did not bind is a `400 connection_not_in_run`, because the run token authorises the connections the run\'s cascade bound and no others. The one caller exempt from it is the ephemeral CONNECT run, which has no run row, no cascade and no bound set — it is authorised by its launcher-published grant and always receives the empty payload.',
  schema: { type: "string", format: "uuid" },
} as const;

/** `connection_id` where only an agent run's token is accepted: no connect-run exemption. */
const boundConnectionIdParam = {
  ...connectionIdParam,
  required: true,
  description:
    "The connection this run bound to the integration: a member of `runs.resolved_connections[<integration id>]`. An id the run did not bind is a `400 connection_not_in_run`.",
} as const;

/** `credential_revision`: which stored credential a sidecar report is about. */
const credentialRevisionParam = {
  name: "credential_revision",
  in: "query",
  schema: { type: "string", pattern: "^[0-9a-f]{16}$" },
} as const;

/** The two ways the `connection_id` selector is refused. Shared by every operation taking it. */
const connectionSelector400 = {
  description:
    "The `connection_id` selector is missing, malformed, or names a connection this run did not bind. `invalid_request` — absent or not a uuid; the platform never picks a connection on the caller's behalf. `connection_not_in_run` — a well-formed id that is not in `runs.resolved_connections` for this integration; the run token authorises this run's bound set only.",
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
        "Sidecar-only. Auth via Bearer run token. Returns the resolved `access_token`, its `expiresAt` and, when the provider surfaced one, the `account_id`. Refreshes the token proactively if it expires within 5 minutes.",
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
        "410": OAUTH_TOKEN_410,
        "502": OAUTH_TOKEN_502,
        "503": { $ref: "#/components/responses/EncryptionKeyUnavailable" },
      },
    },
  },
  "/internal/oauth-token/{credentialId}/refresh": {
    post: {
      operationId: "refreshOAuthModelProviderToken",
      tags: ["Internal"],
      summary: "Force a refresh of the access token for an OAuth model provider connection",
      description:
        "Sidecar-only. Auth via Bearer run token. Forces a refresh regardless of expiry; on a revoked or missing refresh token, flips needsReconnection=true on the connection and returns 410.",
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
        "410": OAUTH_TOKEN_410,
        "502": OAUTH_TOKEN_502,
        "503": { $ref: "#/components/responses/EncryptionKeyUnavailable" },
      },
    },
  },
  "/internal/integration-credentials/{scope}/{name}": {
    get: {
      operationId: "getIntegrationCredentials",
      tags: ["Internal"],
      summary: "Fetch live credentials + HTTP delivery plans for an active integration",
      description:
        "Sidecar-only. Auth via Bearer run token. Backs the MITM `MitmCredentialSource.current()` + `.deliveryPlans()` calls for ONE of the connections this run bound to the integration (named by the required `connection_id`) — returns per-auth resolved credentials + `HttpDeliveryPlan` derived from the integration's `manifest.auths.{key}.delivery.http` declaration. OAuth2 tokens are proactively refreshed when within `OAUTH_REFRESH_LEAD_MS` of expiry. Verifies that the run's agent declares this integration in `dependencies.integrations`, that the integration is ACTIVE in the run's space, AND that the run's kickoff snapshot bound this connection. On the RUN path a `200` always carries a usable credential surface — the only EMPTY payload this endpoint serves is the connect-run one described below. Every state where a credential was expected but could not be produced fails instead — `400` when the selector is missing or names a connection outside the run's bound set, `404` when the named connection is no longer reachable by the actor (deleted/unshared since kickoff), `409` when the pinned manifest version no longer declares the connection's auth, `410` when the credential is dead. The sidecar reads an empty payload as *no `delivery.http` auths, skip the MITM listener*, so answering `200` for a broken state boots the run with zero credentials and every upstream call leaves uncredentialed. One caller is authorised differently: an ephemeral CONNECT run (`run_at: \"link\"` orchestrated `connect.tool` login) has no run row and no agent to walk, so it is authorised against the launcher-published grant naming the single integration it is connecting, and always receives the EMPTY payload — it exists to MINT the credential, its login secret arrives out of band, and the session it captures is installed in-process.",
      security: [{ bearerExecToken: [] }],
      parameters: [
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
        connectionIdParam,
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
        "400": connectionSelector400,
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": integrationCredentialsConflict409,
        "410": credentialFailure(
          "`integration_connection_needs_reconnection`: the credential is dead and the integration connection has been flagged `needsReconnection` — on the plain read too when the stored credentials are unreadable. A key id missing from the keyring is NOT a cause: that is the `503`. The sidecar stops retrying and surfaces this to the integration's MCP client as a 401; the run's `metadata.degraded_integrations[]` is stamped so the finished run shows a reconnect banner.",
        ),
        "502": credentialFailure(
          "A proactive OAuth refresh failed; the credential is not refreshed now and may still be valid. The sidecar's listener cooldown backs off and retries on the next 401.",
        ),
        "503": { $ref: "#/components/responses/EncryptionKeyUnavailable" },
        "500": { $ref: "#/components/responses/InternalServerError" },
      },
    },
  },
  "/internal/integration-credentials/{scope}/{name}/refresh": {
    post: {
      operationId: "refreshIntegrationCredentials",
      tags: ["Internal"],
      summary: "Force-refresh OAuth2 credentials for an active integration",
      description:
        "Sidecar-only. Same response shape and same required `connection_id` selector as the GET endpoint. Reports an upstream 401 on the named connection's credential, which is refreshed regardless of its remaining lifetime (OAuth2) or counted as a rejection (an auth nothing can refresh). Called by the MITM listener's `refreshOnUnauthorized` hook. A rejection is evidence only against the credential it names: when `credential_revision` names one the connection no longer holds, the call is a read — `200` exactly as the GET, nothing refreshed or counted. A connection already flagged `needsReconnection` answers `410` without any token exchange, so its refresh token is never spent. An internal fault that is no verdict on the connection (a database error, an incoherent OAuth client configuration) answers `500`, with nothing flagged or counted. An ephemeral CONNECT run's token is refused here with `409 connect_run_no_refresh`: the platform holds no stored credential for that connection yet — minting one is the reason the connect run exists — so there is nothing a refresh could produce.",
      security: [{ bearerExecToken: [] }],
      parameters: [
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
        boundConnectionIdParam,
        {
          ...credentialRevisionParam,
          required: false,
          description:
            "The `credential_revision` of the credential that was rejected. Omitted only by a caller that holds no credentials payload (a local MCP server reporting a rejected credential it received at spawn); its rejection is then counted against the connection's current credential.",
        },
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
        "400": {
          ...connectionSelector400,
          description: `${connectionSelector400.description} A malformed \`credential_revision\` (empty included) is an \`invalid_request\` too.`,
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": {
          ...integrationCredentialsConflict409,
          description: `${integrationCredentialsConflict409.description} A fourth cause is unique to this operation: \`connect_run_no_refresh\` — the caller is an ephemeral connect run, which has no stored credential to force-refresh (its session is minted in-process by the integration's login tool). The sidecar treats any non-2xx here as "do not retry now" and leaves the upstream response untouched.`,
        },
        "410": credentialFailure(
          "`integration_connection_needs_reconnection`: the credential is dead and the connection is flagged `needsReconnection`; the run records the integration as degraded and the sidecar stops retrying. Counted failures flag it at `INTEGRATION_REFRESH_MAX_FAILURES` (an OAuth2 token only once expired past `INTEGRATION_REFRESH_GRACE_SECONDS`).",
        ),
        "502": credentialFailure(
          "Not refreshed now; the connection stays usable. A successful upstream call through a non-OAuth2 connection (`upstream-success`) or a reconnect resets the count of its rejections.",
        ),
        "503": { $ref: "#/components/responses/EncryptionKeyUnavailable" },
        "500": { $ref: "#/components/responses/InternalServerError" },
      },
    },
  },
  "/internal/integration-credentials/{scope}/{name}/upstream-success": {
    post: {
      operationId: "reportIntegrationUpstreamSuccess",
      tags: ["Internal"],
      summary: "End a connection's upstream-rejection streak",
      description:
        "Sidecar-only. Same Bearer run token, agent-dependency and activation checks and bound-connection check as the GET endpoint; `connection_id` and `credential_revision` are always required. Called once, fire-and-forget, after a successful (2xx) upstream call through the named connection when its credentials payload carried `rejection_streak`, or after the sidecar saw a rejection counted in this run: a non-OAuth2 connection's count of consecutive upstream rejections is reset to 0. Nothing is reset when the connection no longer holds the credential named by `credential_revision`, when the run has no actor or its actor can no longer reach the connection (deleted, unshared, moved to another space), or when the connection is already flagged `needsReconnection`. An OAuth2 connection's count tracks token refreshes and is left untouched. Idempotent. An ephemeral CONNECT run's token is refused with `409 connect_run_no_refresh`, as on the refresh endpoint.",
      security: [{ bearerExecToken: [] }],
      parameters: [
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
        boundConnectionIdParam,
        {
          ...credentialRevisionParam,
          required: true,
          description: "The `credential_revision` of the credential the successful call carried.",
        },
      ],
      responses: {
        "204": { description: "Streak ended (or none to end on that credential)." },
        "400": {
          ...connectionSelector400,
          description: `${connectionSelector400.description} A missing or malformed \`credential_revision\` is an \`invalid_request\` too.`,
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": {
          ...integrationCredentialsConflict409,
          description:
            "The definition this run executes is no longer readable (`run_definition_gone` / `run_agent_deleted`, as on the GET endpoint), so the run token's authorization set cannot be decided; or `connect_run_no_refresh` — the caller is an ephemeral connect run, which holds no stored credential.",
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
        "Container-to-host only. Auth via Bearer run token. Called by the sidecar's integrations-boot to materialise an integration's MCP server before spawning a runner container. In AFPS a local-source integration references a SEPARATE mcp-server package via `source.server.name`; this endpoint serves that package's bundle. It verifies that the run's agent declares an ACTIVE integration (in `dependencies.integrations`) that references this mcp-server — orthogonal access control to the credentials endpoint. An ephemeral CONNECT run has neither a run row nor an agent, so its token is authorised instead against the launcher-published grant, by exact match on the single mcp-server and concrete version its spawn spec resolved — strictly narrower than the dependency walk, never wider. Returns the raw ZIP archive (`application/zip`). The sidecar passes `?version=` with the concrete version the spawn resolver pinned from `source.server.version` (#588) so the bytes match the manifest the resolver read. It is omitted for system mcp-servers: the spawn resolver answers those from the in-memory boot registry, which holds one version per id, so no concrete version is pinned onto the spawn spec and there is nothing for the sidecar to forward. (They do have `package_versions` rows — the route simply never reaches that lookup for them, short-circuiting on the registry first.) For any other mcp-server `?version=` is mandatory — omitting it is a 400, never a fallback to the newest published version (that fallback is the manifest/bytes skew #588 closed).",
      security: [{ bearerExecToken: [] }],
      parameters: [
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
        {
          name: "version",
          in: "query",
          required: false,
          description:
            "Concrete published version to serve (the version the spawn resolver pinned from `source.server.version`). Required for every mcp-server the spawn resolver pinned a version for; omitted only for system mcp-servers, which the route short-circuits to the in-memory boot registry by id alone.",
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
            "Agent does not reference this mcp-server through an active integration, or the requested `?version=` does not exist. For a connect run: the request names a package or version outside its grant, or the grant is gone (the connect run ended, or it expired).",
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
