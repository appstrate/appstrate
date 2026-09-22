// SPDX-License-Identifier: Apache-2.0

import { STD_RESPONSE_HEADERS } from "../headers.ts";
import { UNLISTED_MARKER } from "../visibility.ts";

/**
 * User-scoped identity routes (`/api/me/*`).
 *
 * `/api/me/orgs` is the prerequisite to picking an org and setting
 * `X-Org-Id` — every auth method that represents a single user (cookie
 * session, API key, OAuth2 instance/dashboard/end-user JWTs) is accepted,
 * and the route does NOT require `X-Org-Id` itself.
 *
 * The other routes in this namespace run inside org (or space) context.
 */

/** One skill hint in `GET /api/me/context`, shared by `skills` and `requested_skills`. */
const skillHintSchema = {
  type: "object",
  required: [
    "package_id",
    "display_name",
    "description",
    "version",
    "published",
    "home_writable",
    "source",
  ],
  properties: {
    package_id: {
      type: "string",
      description:
        'Attachable identifier, e.g. "@appstrate/web-research". Declare under dependencies.skills.',
    },
    display_name: { type: "string" },
    description: { type: "string" },
    version: {
      type: ["string", "null"],
      description:
        "The skill package's own manifest version, when known. Use it to pin a satisfiable dependencies.skills range.",
    },
    published: {
      type: "boolean",
      description:
        "True when the skill has a published version (or is a system skill). " +
        "False means draft-only: a manifest range can select nothing, and only " +
        "`dependency_overrides` with `draft` reaches its working copy.",
    },
    home_writable: {
      type: "boolean",
      description:
        "Whether THIS caller may write the skill, i.e. whether its draft is " +
        "theirs to run — `dependency_overrides` with `draft` answers 403 " +
        "`draft_not_writable` otherwise.",
    },
    source: { type: "string", enum: ["system", "local"] },
  },
} as const;

export const mePaths = {
  "/api/me/orgs": {
    get: {
      operationId: "listMyOrgs",
      tags: ["Profile"],
      summary: "List orgs the authenticated caller belongs to",
      description:
        "Returns every org the caller can access. The user's own credential (cookie session, CLI " +
        "or instance token) sees every org they are a member of. A delegated credential — an API " +
        "key, a third-party OAuth client — sees only its bound org, as does an OIDC end-user JWT " +
        "(the org owning its space). " +
        "**Does NOT require `X-Org-Id`** — this endpoint is the prerequisite to setting it.",
      parameters: [{ $ref: "#/components/parameters/XViewAs" }],
      responses: {
        "200": {
          description: "Orgs accessible to the caller",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["object", "data", "hasMore"],
                properties: {
                  object: { type: "string", enum: ["list"] },
                  data: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["id", "name", "slug", "role", "createdAt"],
                      properties: {
                        id: { type: "string" },
                        name: { type: "string" },
                        slug: { type: "string" },
                        role: {
                          type: "string",
                          enum: ["owner", "admin", "member", "guest", "end_user"],
                          description:
                            "Org role for member callers; `end_user` for OIDC end-user JWTs.",
                        },
                        permissions: {
                          type: "array",
                          items: { type: "string" },
                          description:
                            "The caller's ORG-LEVEL effective permissions in this org, ceiling-applied. Absent for OIDC end-user JWTs, which hold no org role.",
                        },
                        createdAt: { type: "string", format: "date-time" },
                      },
                    },
                  },
                  hasMore: { type: "boolean" },
                },
              },
              example: {
                object: "list",
                hasMore: false,
                data: [
                  {
                    id: "org_abc123",
                    name: "Acme Corp",
                    slug: "acme",
                    role: "owner",
                    permissions: ["org:read", "org:update", "members:invite"],
                    createdAt: "2026-01-10T08:00:00Z",
                  },
                ],
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ViewAsRefused" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/me/connections": {
    get: {
      operationId: "listMyConnections",
      tags: ["Profile"],
      summary: "List the caller's connections across every org/space",
      description:
        "Unified user-scope view of the caller's integration connections under a " +
        "single shape, grouped by source package. For the user's own credential " +
        "(cookie session, CLI or instance token) it crosses orgs/spaces by " +
        "design — does NOT require `X-Org-Id`. For a delegated or end-user credential " +
        "the list is scoped to its bound organization, and to its space when it pins one.",
      responses: {
        "200": {
          description: "Connection groups",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["object", "data", "hasMore"],
                properties: {
                  object: { type: "string", enum: ["list"] },
                  data: {
                    type: "array",
                    items: {
                      type: "object",
                      required: [
                        "kind",
                        "source_id",
                        "display_name",
                        "logo",
                        "total_connections",
                        "connections",
                      ],
                      properties: {
                        kind: { type: "string", enum: ["integration"] },
                        source_id: { type: "string" },
                        display_name: { type: "string" },
                        logo: { type: "string" },
                        total_connections: { type: "integer" },
                        connections: {
                          type: "array",
                          items: {
                            type: "object",
                            required: [
                              "connection_id",
                              "kind",
                              "label",
                              "scopes_granted",
                              "connected_at",
                              "needs_reconnection",
                              "expiresAt",
                              "identity",
                              "auth_key",
                              "shared_with_org",
                              "reused_by_agents",
                              "org",
                              "space",
                            ],
                            properties: {
                              connection_id: { type: "string" },
                              kind: { type: "string", enum: ["integration"] },
                              label: { type: ["string", "null"] },
                              scopes_granted: { type: "array", items: { type: "string" } },
                              connected_at: { type: "string", format: "date-time" },
                              needs_reconnection: { type: "boolean" },
                              expiresAt: {
                                oneOf: [{ type: "string", format: "date-time" }, { type: "null" }],
                              },
                              identity: { type: "string" },
                              reused_by_agents: { type: "integer" },
                              auth_key: { type: "string" },
                              shared_with_org: { type: "boolean" },
                              org: {
                                type: "object",
                                required: ["id", "name"],
                                properties: {
                                  id: { type: "string" },
                                  name: { type: "string" },
                                },
                              },
                              space: {
                                type: "object",
                                required: ["id", "name"],
                                properties: {
                                  id: { type: "string" },
                                  name: { type: "string" },
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                  hasMore: { type: "boolean" },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
      },
    },
  },
  "/api/me/integration-pins": {
    get: {
      operationId: "listMyIntegrationPins",
      tags: ["Profile"],
      summary: "List the caller's member-scope integration pins for an agent",
      description:
        "Returns the caller's own (integration, authKey) → connectionId pins for the " +
        "given agent. Used by the agent-page picker to render the collapsed default " +
        "row. Member-only; end-user callers receive an empty list. Requires " +
        "`X-Space-Id`.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        {
          name: "agent_package_id",
          in: "query",
          required: false,
          schema: { type: "string" },
          description:
            "Agent package id whose pins to list. Omitted, the list is empty — " +
            "the picker renders before it has an agent to ask about. The DELETE " +
            "below requires it, because deleting nothing in particular is not a " +
            "coherent request.",
        },
      ],
      responses: {
        "200": {
          description: "Member pins for the agent, or an empty list when no agent was named",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["object", "data", "hasMore"],
                properties: {
                  object: { type: "string", enum: ["list"] },
                  data: {
                    type: "array",
                    // `listMemberPinsForAgent` projects to exactly these two
                    // fields (NOT the 6-field IntegrationPin the PUT route's
                    // `toPinSummary` emits) — keep the list item minimal.
                    items: {
                      type: "object",
                      required: ["integration_package_id", "connection_id"],
                      properties: {
                        integration_package_id: { type: "string" },
                        connection_id: { type: "string", format: "uuid" },
                      },
                    },
                  },
                  hasMore: { type: "boolean" },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    put: {
      operationId: "upsertMyIntegrationPin",
      tags: ["Profile"],
      summary: "Pin a connection for the caller's runs of an agent",
      description:
        "Persists the caller's preference for a (integration, authKey) on this agent. " +
        "Sits at cascade layer 4 — wins over the fallback ambiguity but loses to admin " +
        "pins / run / schedule overrides. Replaces the previous R5 localStorage pick. " +
        "Idempotent — repeated calls update the row in place.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["agent_package_id", "integration_package_id", "connection_id"],
              properties: {
                agent_package_id: { type: "string", minLength: 1 },
                integration_package_id: { type: "string", minLength: 1 },
                connection_id: { type: "string", format: "uuid" },
              },
              additionalProperties: false,
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Member pin set",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/IntegrationPin" },
            },
          },
        },
        "400": {
          description:
            "Validation failed (connection wrong integration/auth, or not accessible to caller).",
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    delete: {
      operationId: "deleteMyIntegrationPin",
      tags: ["Profile"],
      summary: "Clear the caller's pin on a (agent, integration)",
      description:
        "Removes the caller's member pin so the resolver falls back to layer 5 " +
        "(accessible connections). Idempotent — 204 even when no row exists.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        {
          name: "agent_package_id",
          in: "query",
          required: true,
          schema: { type: "string" },
        },
        {
          name: "integration_package_id",
          in: "query",
          required: true,
          schema: { type: "string" },
        },
      ],
      responses: {
        "204": { description: "Pin cleared (or never existed)" },
        "400": {
          description: "Missing required query param (agent_package_id or integration_package_id).",
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/me/connections/{connectionId}": {
    delete: {
      operationId: "deleteMyConnection",
      tags: ["Profile"],
      summary: "Delete one of the caller's own connections (destructive)",
      description:
        "Removes the `integration_connections` row globally. ON DELETE CASCADE vacates " +
        "every reference (admin pins, member pins, run snapshots, schedule overrides). " +
        "Intent is destructive: 'I never want to use this credential anywhere again'. " +
        "Surfaced only from the /connections management page — agent-surface unlinks now " +
        "drop the member pin instead (see `DELETE /api/me/integration-pins`). " +
        "With a delegated or end-user credential, only connections inside its bound " +
        "organization (and space, when it pins one) can be deleted (204 with no effect otherwise).",
      parameters: [
        {
          name: "connectionId",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      responses: {
        "204": { description: "Connection deleted (or never existed)" },
        "401": { $ref: "#/components/responses/Unauthorized" },
      },
    },
  },
  "/api/me/connections/{connectionId}/handoff": {
    get: {
      operationId: "getMyConnectionHandoff",
      tags: ["Profile"],
      summary: "What is due on the target when this connection is deleted",
      description:
        "For a connection whose credentials the platform minted, the steps to run on the " +
        "target when deleting it (e.g. removing the installed key) — deleting the connection " +
        "cannot reach the target. Creation-time steps come only from `submitIntegrationConnect`. " +
        "`deferred` is omitted: every step here is deletion-time. Empty for an auth that mints " +
        "nothing, and for an unknown, malformed or not-owned id.",
      parameters: [
        {
          name: "connectionId",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      responses: {
        "200": {
          description: "Handoff steps due at deletion (possibly empty)",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["object", "data", "hasMore"],
                properties: {
                  object: { type: "string", enum: ["list"] },
                  hasMore: { type: "boolean" },
                  data: {
                    type: "array",
                    items: { $ref: "#/components/schemas/HandoffCommandStep" },
                  },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
      },
    },
  },
  "/api/me/context": {
    get: {
      operationId: "getMyContext",
      tags: ["Profile"],
      summary: "The caller's working context for an AI agent",
      description:
        "Returns the caller's identity, their role in the pinned org, and the integrations " +
        "they could attach when building an agent in the current space (their own or " +
        "org-shared). One payload powering the chat system prompt, the MCP `get_me` tool, and " +
        "direct API/MCP callers — so an agent can prefer already-connected integrations and " +
        "respect the caller's role (operations beyond it 403 at invoke time). Space context " +
        "resolves from `X-Space-Id`, the API key's space, or the org default.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        {
          name: "skills",
          in: "query",
          required: false,
          description:
            "Comma-separated `@scope/name` skill ids to resolve by exact id into " +
            "`requested_skills`, unlisted ones included. At most 30 distinct ids; a malformed " +
            "id or more than 30 is a 400, an unknown or unreadable id lands in `unresolved_skills`.",
          schema: { type: "string" },
          example: "@appstrate/copilot,@appstrate/web-search",
        },
      ],
      responses: {
        "200": {
          description: "Caller context",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: [
                  "user",
                  "org",
                  "space",
                  "connections",
                  "recent_runs",
                  "agents",
                  "agents_truncated",
                  "agents_total",
                  "skills",
                  "skills_truncated",
                  "skills_total",
                  "requested_skills",
                  "unresolved_skills",
                ],
                properties: {
                  user: {
                    type: "object",
                    required: ["id", "name", "email"],
                    properties: {
                      id: { type: "string" },
                      name: { type: ["string", "null"] },
                      email: { type: ["string", "null"] },
                    },
                  },
                  org: {
                    type: "object",
                    required: ["id", "role"],
                    properties: {
                      id: { type: "string" },
                      role: {
                        type: "string",
                        enum: ["owner", "admin", "member", "guest", "end_user"],
                      },
                      name: {
                        type: ["string", "null"],
                        description: "Human-readable organization name.",
                      },
                      slug: { type: ["string", "null"], description: "Organization slug." },
                    },
                  },
                  space: {
                    type: "object",
                    description:
                      "The space this context resolved in (`X-Space-Id`, the API key's space, " +
                      "or the org default). Its `id` is the `spaceId` path parameter of " +
                      "space-scoped operations such as `POST /api/spaces/{spaceId}/packages`.",
                    required: ["id"],
                    properties: {
                      id: { type: "string", description: 'Space id, e.g. "spc_abc123".' },
                    },
                  },
                  recent_runs: {
                    type: "array",
                    description:
                      "The caller's own most recent runs (actor-scoped), newest first — lets " +
                      "an agent reference a recent or failed run without a discovery round-trip.",
                    items: {
                      type: "object",
                      required: ["package_id", "status"],
                      properties: {
                        package_id: { type: "string" },
                        status: { type: "string" },
                        // CASING: `run_number` is snake_case here, diverging from
                        // the universal `runNumber` carve-out used by the Run
                        // schema. This is a distinct, prompt-oriented projection
                        // (`services/state/runs.ts:listRecentForActor`) that emits
                        // snake_case keys; spec matches that runtime output
                        // (spec==runtime invariant). Documented divergence.
                        run_number: { type: ["integer", "null"] },
                        started_at: { type: ["string", "null"], format: "date-time" },
                        error: {
                          type: ["string", "null"],
                          description: "Failure message for non-success runs, when available.",
                        },
                      },
                    },
                  },
                  connections: {
                    type: "array",
                    description: "Integrations the caller could attach to an agent.",
                    items: {
                      type: "object",
                      required: ["integration_id", "name", "source"],
                      properties: {
                        integration_id: { type: "string" },
                        name: { type: "string" },
                        source: { type: "string", enum: ["own", "shared", "both"] },
                        version: {
                          type: "string",
                          description:
                            "The integration package's own manifest version, when known. Use it to pin a satisfiable dependencies.integrations range.",
                        },
                        default_tools: {
                          description:
                            "AFPS §4.4 — tool(s) an agent inherits when it declares this integration without an `integrations_configuration.<id>.tools` selection. Absent or `[]` means an agent that declares this integration without its own selection ends up with nothing callable, which publish/import reject and the run aborts on — such an agent must select a tool explicitly. To use any other tool, inspect the full `tool_catalog` via GET /api/integrations/{packageId}.",
                          oneOf: [
                            { type: "array", items: { type: "string" } },
                            { type: "string", enum: ["*"] },
                          ],
                        },
                      },
                    },
                  },
                  agents: {
                    type: "array",
                    description:
                      "Agents the caller can run in the current space (capped). Only " +
                      "present when the caller holds the `agents:run` permission; empty otherwise. " +
                      "When `agents_truncated` is true, the full list is reachable via the " +
                      "`listAgents` operation. " +
                      `Unlisted packages (${UNLISTED_MARKER}) are neither listed nor counted.`,
                    items: {
                      type: "object",
                      required: [
                        "package_id",
                        "display_name",
                        "description",
                        "takes_input",
                        "published",
                        "home_writable",
                        "source",
                      ],
                      properties: {
                        package_id: {
                          type: "string",
                          description: 'Invokable identifier, e.g. "@appstrate/triage".',
                        },
                        display_name: { type: "string" },
                        description: { type: "string" },
                        takes_input: {
                          type: "boolean",
                          description:
                            "Whether the agent declares an input schema with properties.",
                        },
                        published: {
                          type: "boolean",
                          description:
                            "True when the agent has a published version (or is a system agent) — " +
                            "run it via `runAgent` with `version` omitted. False means draft-only: " +
                            "omitting `version` answers 404 `no_published_version`.",
                        },
                        home_writable: {
                          type: "boolean",
                          description:
                            "Whether THIS caller may write the agent, i.e. whether its draft is " +
                            "theirs to run with `version=draft` (403 `draft_not_writable` " +
                            "otherwise). Read with `published`: false/false is an agent this " +
                            "caller cannot execute at all until its author publishes one.",
                        },
                        source: { type: "string", enum: ["system", "local"] },
                      },
                    },
                  },
                  agents_truncated: {
                    type: "boolean",
                    description:
                      "True when the agent list was capped (full list via `listAgents`).",
                  },
                  agents_total: {
                    type: "integer",
                    description: "Total runnable agents before the cap.",
                  },
                  skills: {
                    type: "array",
                    description:
                      "Skills the caller could attach to an agent in the current space " +
                      "(capped). A catalogue read, not a runnable hint: only present when the " +
                      "caller holds the `skills:read` permission; empty otherwise. Skills are not run directly — declare them under an agent " +
                      "manifest's `dependencies.skills`. When `skills_truncated` is true, the " +
                      "full list is reachable via the `listSkills` operation. " +
                      `Unlisted packages (${UNLISTED_MARKER}) are neither listed nor counted.`,
                    items: skillHintSchema,
                  },
                  skills_truncated: {
                    type: "boolean",
                    description:
                      "True when the skill list was capped (full list via `listSkills`).",
                  },
                  skills_total: {
                    type: "integer",
                    description: "Total active skills before the cap.",
                  },
                  requested_skills: {
                    type: "array",
                    description:
                      "Skills named by the `skills` query parameter that resolved in this space " +
                      "(unlisted included), sorted by `package_id`. Empty without the parameter " +
                      "or without `skills:read`.",
                    items: skillHintSchema,
                  },
                  unresolved_skills: {
                    type: "array",
                    description:
                      "Requested ids that did not resolve (unknown, not active here, or out of " +
                      "reach), in request order. Empty without `skills:read`.",
                    items: { type: "string" },
                  },
                },
              },
              example: {
                user: { id: "user_abc", name: "Ada Lovelace", email: "ada@acme.com" },
                org: { id: "org_abc123", role: "member", name: "Acme", slug: "acme" },
                space: { id: "spc_abc123" },
                connections: [
                  { integration_id: "@appstrate/gmail", name: "Gmail", source: "own" },
                  { integration_id: "@appstrate/clickup", name: "ClickUp", source: "shared" },
                ],
                recent_runs: [
                  {
                    package_id: "@appstrate/triage",
                    status: "failed",
                    run_number: 7,
                    started_at: "2026-06-25T09:12:00.000Z",
                    error: "Gmail token expired",
                  },
                ],
                agents: [
                  {
                    package_id: "@appstrate/triage",
                    display_name: "Inbox Triage",
                    description: "Sorts and labels incoming email.",
                    takes_input: false,
                    published: true,
                    home_writable: false,
                    source: "system",
                  },
                ],
                agents_truncated: false,
                agents_total: 1,
                skills: [
                  {
                    package_id: "@appstrate/web-research",
                    display_name: "Web Research",
                    description: "Multi-source web search and synthesis.",
                    version: "1.2.0",
                    published: true,
                    home_writable: false,
                    source: "system",
                  },
                ],
                skills_truncated: false,
                skills_total: 1,
                requested_skills: [
                  {
                    package_id: "@appstrate/copilot",
                    display_name: "Agent Copilot",
                    description: "Interviews the user, then assembles an agent.",
                    version: "1.0.0",
                    published: true,
                    home_writable: false,
                    source: "system",
                  },
                ],
                unresolved_skills: ["@acme/retired"],
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
  },
} as const;
