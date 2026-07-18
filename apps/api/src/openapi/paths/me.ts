// SPDX-License-Identifier: Apache-2.0

/**
 * User-scoped identity routes (`/api/me/*`).
 *
 * `/api/me/orgs` is the prerequisite to picking an org and setting
 * `X-Org-Id` — every auth method that represents a single user (cookie
 * session, API key, OAuth2 instance/dashboard/end-user JWTs) is accepted,
 * and the route does NOT require `X-Org-Id` itself.
 *
 * `/api/me/models` runs inside org context and returns the catalog the SPA
 * model picker consumes.
 */

export const mePaths = {
  "/api/me/orgs": {
    get: {
      operationId: "listMyOrgs",
      tags: ["Profile"],
      summary: "List orgs the authenticated caller belongs to",
      description:
        "Returns every org the caller can access. Cookie sessions and OIDC dashboard JWTs see " +
        "every org the user is a member of. API keys see only their bound org. OIDC end-user " +
        "JWTs see the single org owning their application. " +
        "**Does NOT require `X-Org-Id`** — this endpoint is the prerequisite to setting it.",
      responses: {
        "200": {
          description: "Orgs accessible to the caller",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
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
                          enum: ["owner", "admin", "member", "viewer", "end_user"],
                          description:
                            "Org role for member callers; `end_user` for OIDC end-user JWTs.",
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
                    createdAt: "2026-01-10T08:00:00Z",
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
  "/api/me/connections": {
    get: {
      operationId: "listMyConnections",
      tags: ["Profile"],
      summary: "List the caller's connections across every org/app",
      description:
        "Unified user-scope view of the caller's integration connections under a " +
        "single shape, grouped by source package. For interactive user credentials " +
        "(cookie session, dashboard/instance JWT) it crosses orgs/applications by " +
        "design — does NOT require `X-Org-Id`. For an API key the list is scoped " +
        "to the key's bound organization and application only.",
      responses: {
        "200": {
          description: "Connection groups",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
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
                              "application",
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
                              application: {
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
        "`X-Application-Id`.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        {
          name: "agent_package_id",
          in: "query",
          required: true,
          schema: { type: "string" },
          description: "Agent package id whose pins to list.",
        },
      ],
      responses: {
        "200": {
          description: "Member pins for the agent",
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
        "400": { $ref: "#/components/responses/ValidationError" },
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
        { $ref: "#/components/parameters/XAppId" },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["agent_package_id", "integration_package_id", "connection_id"],
              properties: {
                agent_package_id: { type: "string" },
                integration_package_id: { type: "string" },
                connection_id: { type: "string", format: "uuid" },
              },
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
        { $ref: "#/components/parameters/XAppId" },
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
        "With an API key, only connections inside the key's bound organization and " +
        "application can be deleted (204 with no effect otherwise).",
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
  "/api/me/models": {
    get: {
      operationId: "listMyModels",
      tags: ["Profile"],
      summary: "List models available in the active org",
      description:
        "Returns the model catalog for the active org (built-in + custom). Same shape as " +
        "`GET /api/models`. Org context is set by the `X-Org-Id` header (cookie session) " +
        "or pinned by the strategy (API key, OIDC). Requires `models:read`.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      responses: {
        "200": {
          description: "Model catalog",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["object", "data", "hasMore"],
                properties: {
                  object: { type: "string", enum: ["list"] },
                  data: {
                    type: "array",
                    items: { $ref: "#/components/schemas/OrgModel" },
                  },
                  hasMore: { type: "boolean" },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
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
        "they could attach when building an agent in the current application (their own or " +
        "org-shared). One payload powering the chat system prompt, the MCP `get_me` tool, and " +
        "direct API/MCP callers — so an agent can prefer already-connected integrations and " +
        "respect the caller's role (operations beyond it 403 at invoke time). App context " +
        "resolves from `X-Application-Id`, the API key's application, or the org default.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
      ],
      responses: {
        "200": {
          description: "Caller context",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: [
                  "user",
                  "org",
                  "connections",
                  "recent_runs",
                  "agents",
                  "agents_truncated",
                  "agents_total",
                  "skills",
                  "skills_truncated",
                  "skills_total",
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
                        enum: ["owner", "admin", "member", "viewer", "end_user"],
                      },
                      name: {
                        type: ["string", "null"],
                        description: "Human-readable organization name.",
                      },
                      slug: { type: ["string", "null"], description: "Organization slug." },
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
                            "AFPS §4.4 — tool(s) an agent inherits when it declares this integration without an `integrations_configuration.<id>.tools` selection. Absent when none declared; `[]` means the integration is inert. To use any other tool, inspect the full `tool_catalog` via GET /api/integrations/{packageId}.",
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
                      "Agents the caller can run in the current application (capped). Only " +
                      "present when the caller holds the `agents:run` permission; empty otherwise. " +
                      "When `agents_truncated` is true, the long tail is reachable via the MCP " +
                      "`search_operations` tool.",
                    items: {
                      type: "object",
                      required: [
                        "package_id",
                        "display_name",
                        "description",
                        "takes_input",
                        "published",
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
                            "True when the agent has a published version (or is a system agent). " +
                            "Run it via `runAgent` with `version` omitted. When false the agent is " +
                            "draft-only — run it with `version=draft` (omitting `version` would 404 " +
                            "`no_published_version`).",
                        },
                        source: { type: "string", enum: ["system", "local"] },
                      },
                    },
                  },
                  agents_truncated: {
                    type: "boolean",
                    description:
                      "True when the agent list was capped (more via search_operations).",
                  },
                  agents_total: {
                    type: "integer",
                    description: "Total runnable agents before the cap.",
                  },
                  skills: {
                    type: "array",
                    description:
                      "Skills the caller could attach to an agent in the current application " +
                      "(capped). Only present when the caller holds the `agents:run` permission; " +
                      "empty otherwise. Skills are not run directly — declare them under an agent " +
                      "manifest's `dependencies.skills`. When `skills_truncated` is true, the long " +
                      "tail is reachable via the MCP `search_operations` tool.",
                    items: {
                      type: "object",
                      required: [
                        "package_id",
                        "display_name",
                        "description",
                        "version",
                        "published",
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
                            "When false the skill is draft-only — pin it for a run via " +
                            "`dependency_overrides` with `draft`.",
                        },
                        source: { type: "string", enum: ["system", "local"] },
                      },
                    },
                  },
                  skills_truncated: {
                    type: "boolean",
                    description:
                      "True when the skill list was capped (more via search_operations).",
                  },
                  skills_total: {
                    type: "integer",
                    description: "Total installed skills before the cap.",
                  },
                },
              },
              example: {
                user: { id: "user_abc", name: "Ada Lovelace", email: "ada@acme.com" },
                org: { id: "org_abc123", role: "member", name: "Acme", slug: "acme" },
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
                    source: "system",
                  },
                ],
                skills_truncated: false,
                skills_total: 1,
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
  },
} as const;
