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
        "single shape, grouped by source package. Crosses orgs/applications by " +
        "design — does NOT require `X-Org-Id`.",
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
                              identity: { type: ["string", "null"] },
                              reused_by_agents: { type: ["integer", "null"] },
                              auth_key: { type: ["string", "null"] },
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
          name: "agentPackageId",
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
          name: "agentPackageId",
          in: "query",
          required: true,
          schema: { type: "string" },
        },
        {
          name: "integrationPackageId",
          in: "query",
          required: true,
          schema: { type: "string" },
        },
      ],
      responses: {
        "204": { description: "Pin cleared (or never existed)" },
        "400": {
          description: "Missing required query param (agentPackageId or integrationPackageId).",
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
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
        "drop the member pin instead (see `DELETE /api/me/integration-pins`).",
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
} as const;
