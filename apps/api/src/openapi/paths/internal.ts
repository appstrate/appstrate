// SPDX-License-Identifier: Apache-2.0

import { MAX_CONNECTIONS_PER_INTEGRATION } from "@appstrate/core/integration";
import { CREDENTIAL_FAILURE_CAUSES } from "@appstrate/core/sidecar-types";
import { CREDENTIAL_FAILURE_SENTENCES } from "../../lib/credential-failure.ts";
import { jsonRpcRequestBody } from "../responses.ts";
import {
  RUN_TOOLS_MCP_DESCRIPTION,
  runToolsMcpMethodNotAllowed,
  runToolsMcpResponses,
} from "./run-tools-mcp.ts";

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
  "/internal/mcp": {
    post: {
      operationId: "internalRunToolsMcpPost",
      "x-appstrate-space": { kind: "organization" },
      tags: ["Internal"],
      summary: "Run MCP server of a platform run",
      description:
        RUN_TOOLS_MCP_DESCRIPTION +
        " Mounted here for the sidecar. Container-to-host only. Auth via Bearer run token, which names the run; a run that is not `running` is refused with 403.",
      security: [{ bearerExecToken: [] }],
      requestBody: jsonRpcRequestBody,
      responses: {
        ...runToolsMcpResponses,
        "401": { $ref: "#/components/responses/Unauthorized" },
        "429": { $ref: "#/components/responses/RateLimited" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    get: {
      operationId: "internalRunToolsMcpGet",
      "x-appstrate-space": { kind: "organization" },
      tags: ["Internal"],
      summary: "Run MCP server of a platform run (GET)",
      description:
        "The GET channel of the run MCP server. The server is stateless and opens no standalone server-initiated SSE stream, so GET (and every verb but POST) answers 405. Container-to-host only.",
      security: [],
      responses: { "405": runToolsMcpMethodNotAllowed },
    },
  },
  "/internal/oauth-token/{credentialId}": {
    get: {
      operationId: "getOAuthModelProviderToken",
      "x-appstrate-space": { kind: "organization" },
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
        "429": { $ref: "#/components/responses/RateLimited" },
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
      "x-appstrate-space": { kind: "organization" },
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
        "429": { $ref: "#/components/responses/RateLimited" },
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
      "x-appstrate-space": { kind: "organization" },
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
        "429": { $ref: "#/components/responses/RateLimited" },
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
      "x-appstrate-space": { kind: "organization" },
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
        {
          name: "rejected_request",
          in: "query",
          required: false,
          schema: { type: "string", enum: ["handshake"] },
          description:
            "`handshake`: the rejected request is the MCP handshake (`initialize`) the sidecar sends to a remote MCP server at boot, which no agent input shapes. An auth nothing can refresh is then flagged on this first rejection (`410`) instead of counted toward `INTEGRATION_REFRESH_MAX_FAILURES`. Omitted for a request made on the agent's behalf (tool call, `api_call`, MITM request). An OAuth2 credential that can be refreshed is refreshed either way.",
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
          description: `${connectionSelector400.description} A malformed \`credential_revision\` (empty included) or a \`rejected_request\` other than \`handshake\` is an \`invalid_request\` too.`,
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "429": { $ref: "#/components/responses/RateLimited" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": {
          ...integrationCredentialsConflict409,
          description: `${integrationCredentialsConflict409.description} A fourth cause is unique to this operation: \`connect_run_no_refresh\` — the caller is an ephemeral connect run, which has no stored credential to force-refresh (its session is minted in-process by the integration's login tool). The sidecar treats any non-2xx here as "do not retry now" and leaves the upstream response untouched.`,
        },
        "410": credentialFailure(
          "`integration_connection_needs_reconnection`: the credential is dead and the connection is flagged `needsReconnection`; the run records the integration as degraded and the sidecar stops retrying. Counted failures flag it at `INTEGRATION_REFRESH_MAX_FAILURES` (an OAuth2 token only once expired past `INTEGRATION_REFRESH_GRACE_SECONDS`); a rejected handshake (`rejected_request=handshake`) of an auth nothing can refresh flags it at once.",
        ),
        "502": credentialFailure(
          "Not refreshed now; the connection stays usable. A successful upstream call through a non-OAuth2 connection (journaled with its `credential_revision` on `POST /internal/integration-calls`) or a reconnect resets the count of its rejections.",
        ),
        "503": { $ref: "#/components/responses/EncryptionKeyUnavailable" },
        "500": { $ref: "#/components/responses/InternalServerError" },
      },
    },
  },
  "/internal/integration-calls": {
    post: {
      operationId: "reportIntegrationCalls",
      "x-appstrate-space": { kind: "organization" },
      tags: ["Internal"],
      summary: "Journal the upstream calls a run's sidecar dispatched",
      description:
        "Sidecar-only. Auth via Bearer run token. A batch of the upstream calls the run's sidecar dispatched for its integrations (the `api_call` tool, the MITM listener, a remote MCP server's operations, a local MCP server's `tools/call` when no MITM listener sees its upstream requests), one record per call that may have reached the upstream, taken from its final attempt. Each is written to the connection-call journal (`connection_calls`) with the run's organization, space, actor and API key, `auth_method` `run_token`, `run_id` set and a null `request_id` (the batch's request is not the call's); the sidecar sends none of those. A record carries its `call_id` and `called_at`, stored as the row's `call_id` and `called_at`: `(run_id, call_id)` is unique, so a batch sent twice is stored once and the second answers `204` as well. Every record is checked before any is written, against the run's frozen kickoff snapshot alone — never the live agent or the space's activation, so a call that left stays journaled when its integration is switched off or the agent edited or deleted mid-run: a non-null `connection_id` is one the run bound to that integration (else `400 connection_not_in_run`), and a record with a null `connection_id` names an integration the run resolved (else `400 invalid_request`); one record that fails refuses the whole batch. The text of a record is bounded at 2048 characters and stored truncated to the journal's own caps. A run with no actor writes nothing and answers `204`. A record carrying `credential_revision` (a 2xx answered with that credential) also ends the connection's rejection streak: a non-OAuth2 connection's count of consecutive upstream rejections is reset to 0, unless the connection no longer holds that credential, the run's actor can no longer reach it (deleted, unshared, moved to another space), or it is already flagged `needsReconnection`. An OAuth2 connection's count tracks token refreshes and is left untouched. A token whose run is no longer `running` is refused (`403`).",
      security: [{ bearerExecToken: [] }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["calls"],
              properties: {
                calls: {
                  type: "array",
                  minItems: 1,
                  maxItems: 100,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: [
                      "call_id",
                      "called_at",
                      "integration_id",
                      "connection_id",
                      "method",
                      "host",
                      "outcome",
                      "duration_ms",
                    ],
                    properties: {
                      call_id: {
                        type: "string",
                        format: "uuid",
                        description:
                          "The call's identity (a UUIDv7 the sidecar mints); with the run, the key a retried batch is deduplicated on.",
                      },
                      called_at: {
                        type: "string",
                        format: "date-time",
                        description: "When the upstream call started (RFC 3339, with an offset).",
                      },
                      integration_id: {
                        type: "string",
                        minLength: 1,
                        maxLength: 214,
                        description: "The integration's package id (`@scope/name`).",
                      },
                      connection_id: {
                        type: ["string", "null"],
                        format: "uuid",
                        description:
                          "The bound connection the call went through; `null` for an integration that binds none.",
                      },
                      method: {
                        type: "string",
                        maxLength: 2048,
                        pattern: "^[!#$%&'*+.^_`|~0-9A-Za-z-]+$",
                        description:
                          "The request's HTTP method (an RFC 9110 token), `POST` for a local MCP server's `tools/call`. Stored truncated to 16 characters.",
                      },
                      host: {
                        type: ["string", "null"],
                        minLength: 1,
                        maxLength: 2048,
                        description:
                          "The target's host as the caller wrote it, before any credential substitution: a `{{field}}` placeholder stays as written. Stored truncated to 255 characters. `null` for a `tools/call` of a local MCP server with no MITM listener (env- or files-delivery, or no credential), whose upstream requests the sidecar does not see.",
                      },
                      outcome: {
                        type: "string",
                        description:
                          "The upstream's HTTP status (any three digits: some upstreams answer outside 1xx-5xx), or the failure code of a call that was sent and got no response: `unauthorized_target`, `blocked_target`, `upstream_unresolvable`, `upstream_unreachable`, `upstream_timeout`.",
                      },
                      duration_ms: {
                        type: "integer",
                        minimum: 0,
                        maximum: 2147483647,
                      },
                      credential_revision: {
                        type: "string",
                        pattern: "^[0-9a-f]{16}$",
                        description:
                          "Set on a 2xx answered with the injected credential when it ends a rejection streak the sidecar knows of: the `credential_revision` of that credential. Only with a non-null `connection_id` and a 2xx `outcome`.",
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      responses: {
        "204": { description: "Journaled (nothing with no actor)." },
        "400": {
          description:
            "`invalid_request`: a malformed body (more than 100 records, an unknown field, a value out of its bounds, a `credential_revision` on a record that cannot end a streak), or a record with a null `connection_id` names an integration the run did not resolve (`param` points at it); or `connection_not_in_run`: a record names a connection the run did not bind to its integration (`param` points at it).",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "429": { $ref: "#/components/responses/RateLimited" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "500": { $ref: "#/components/responses/InternalServerError" },
      },
    },
  },
  "/internal/integration-bundle/{scope}/{name}": {
    get: {
      operationId: "getIntegrationBundle",
      "x-appstrate-space": { kind: "organization" },
      tags: ["Internal"],
      summary: "Fetch the archive of a local integration (manifest and server payload)",
      description:
        "Container-to-host only. Auth via Bearer run token. Called by the sidecar's integrations-boot to materialise a local integration's MCP server before spawning a runner container. A local integration declares its server inline (`source.server`) and ships the payload in its own archive; `server.entry_point` is relative to the archive root. The route verifies that the run's agent declares this integration in `dependencies.integrations`, that it is ACTIVE in the run's space and that it is a local one with a server — orthogonal access control to the credentials endpoint. An ephemeral CONNECT run has neither a run row nor an agent, so its token is authorised instead against the launcher-published grant, by exact match on the single integration and concrete version its spawn spec names — strictly narrower than the dependency walk, never wider. Returns the raw ZIP archive (`application/zip`). Which bytes: the version the run froze (`runs.resolved_integration_versions`). The spawn spec names a published version in `server.version` and the sidecar forwards it as `?version=`, which must be exactly that version — never a fallback to the newest published one (that would skew the manifest from the bytes). A system integration is answered from the in-memory boot registry, and an integration the run froze on its draft (a `draft` dependency override) from the draft files, read at fetch time (a draft edited after launch is served as edited); neither spec carries a version, and `?version=` is refused for them.",
      security: [{ bearerExecToken: [] }],
      parameters: [
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
        {
          name: "version",
          in: "query",
          required: false,
          description:
            "Concrete published version to serve — exactly the one the run froze (the spawn spec's `server.version`). Omitted for a system integration (boot registry) and for a draft run (draft files); a version sent for those, or a different one, is a 404.",
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
        "429": { $ref: "#/components/responses/RateLimited" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": {
          description:
            "The run's agent does not declare this integration, it is not active in the space or not a local one, the run froze no version for it, or `?version=` is not the version the run froze. For a connect run: the request names an integration or version outside its grant, or the grant is gone (the connect run ended, or it expired).",
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
