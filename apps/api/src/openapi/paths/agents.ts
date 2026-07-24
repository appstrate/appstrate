// SPDX-License-Identifier: Apache-2.0

/**
 * Agents paths — includes both agents.ts and user-agents.ts endpoints
 * since they share base paths (e.g. /api/agents/{scope}/{name}).
 */
export const agentsPaths = {
  "/api/agents": {
    get: {
      operationId: "listAgents",
      tags: ["Agents"],
      summary: "List all agents",
      description:
        "Returns all agents (system + user-imported) with running run counts. Requires `X-Org-Id` header for cookie auth.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
      ],
      responses: {
        "200": {
          description: "Agent list",
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
                    items: { $ref: "#/components/schemas/AgentListItem" },
                  },
                  hasMore: { type: "boolean" },
                },
              },
              example: {
                object: "list",
                hasMore: false,
                data: [
                  {
                    id: "@acme/email-sorter",
                    display_name: "Email Sorter",
                    description: "Automatically sorts and labels incoming emails",
                    schema_version: "0.1",
                    author: "Acme Corp",
                    keywords: ["email", "automation"],
                    source: "local",
                    scope: "@acme",
                    version: "1.2.0",
                    type: "agent",
                    running_runs: 1,
                    dependencies: {
                      skills: {},
                      mcp_servers: {},
                      integrations: {},
                    },
                  },
                  {
                    id: "@appstrate/code-reviewer",
                    display_name: "Code Reviewer",
                    description: "Reviews pull requests and suggests improvements",
                    schema_version: "0.1",
                    author: "Appstrate",
                    keywords: ["code", "review", "github"],
                    source: "system",
                    scope: "@appstrate",
                    version: "2.0.0",
                    type: "agent",
                    running_runs: 0,
                    dependencies: {
                      skills: { "@appstrate/summarize": "^1.0.0" },
                      mcp_servers: { "@appstrate/filesystem-mcp": "^1.0.0" },
                      integrations: { "@appstrate/github": "^2.0.0" },
                    },
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
  "/api/agents/{scope}/{name}/config": {
    put: {
      operationId: "saveAgentConfig",
      tags: ["Agents"],
      summary: "Save agent configuration",
      description: "Save agent configuration values. Validated against manifest config schema.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { type: "object", additionalProperties: true },
          },
        },
      },
      responses: {
        "200": {
          description: "Configuration saved — returns the bare persisted configuration document",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              // Bare persisted configuration document (request body merged
              // with schema defaults) — no `validation` echo (#657):
              // validation failures are 400s.
              schema: { type: "object", additionalProperties: true },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/agents/{scope}/{name}/proxy": {
    get: {
      operationId: "getAgentProxy",
      tags: ["Agents"],
      summary: "Get agent proxy configuration",
      description:
        "Returns the proxy configuration for an agent (override ID and resolution status).",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
      ],
      responses: {
        "200": {
          description: "Agent proxy config",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  proxyId: { type: ["string", "null"] },
                  resolved: { type: "boolean" },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    put: {
      operationId: "setAgentProxy",
      tags: ["Agents"],
      summary: "Set agent proxy override",
      description:
        'Set a proxy override for this agent. Pass a proxy ID, "none" to disable proxying, or null to use org default.',
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["proxyId"],
              properties: {
                proxyId: {
                  type: ["string", "null"],
                  description: 'Proxy ID, "none" to opt out, or null for org default',
                },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Agent proxy updated — returns the bare proxy-setting resource",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              // Bare proxy-setting resource — same shape as GET …/proxy,
              // no `success` scrap (#657).
              schema: {
                type: "object",
                required: ["proxyId", "resolved"],
                properties: {
                  proxyId: { type: ["string", "null"] },
                  resolved: { type: "boolean" },
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
  },
  "/api/agents/{scope}/{name}/connection-readiness": {
    get: {
      operationId: "getAgentConnectionReadiness",
      tags: ["Agents"],
      summary: "Bulk integration connection readiness for an agent",
      description:
        "Single call replacing N per-integration resolutions. `blocks_run`/`errors` are the authoritative run-blocking verdict (identical to the run-kickoff 412 — run semantics, includeInert false + required-auth carve-out). `integrations[]` lists every declared integration with its management verdict (includeInert true) so the Connexions tab and the launch badge share one source of truth.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
        {
          name: "version",
          in: "query",
          required: false,
          schema: { type: "string" },
          description:
            "Which agent definition to assess: `draft` (the live editor working copy), `published` (the latest published version), or a version spec (exact version, dist-tag, or semver range). **Omitting the parameter resolves the `draft`** — preserving the launch-badge default. Pass a concrete version to get the same run-blocking verdict the run would produce for that pinned version (issue #770), so the modal and badge never disagree with the actual run. Ignored for system agents.",
        },
      ],
      responses: {
        "200": {
          description: "Connection readiness",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/AgentConnectionReadiness" },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/agents/{scope}/{name}/persistence": {
    get: {
      operationId: "listAgentPersistence",
      tags: ["Agents"],
      summary: "List unified agent persistence (pinned slots + memories)",
      description:
        "Returns the agent's named pinned slots and archive memories visible to the caller's actor scope. Pinned slots include the `checkpoint` carry-over slot alongside Letta-style named blocks (`persona`, `goals`, …). Admins inspecting at agent level (no `actor_type` and no `runId`) see every actor's pinned slots; members always see their own actor scope plus shared rows.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
        {
          name: "kind",
          in: "query",
          required: false,
          schema: { type: "string", enum: ["pinned", "memory"] },
          description: "Limit the response to one kind. Omitted → both.",
        },
        {
          name: "actor_type",
          in: "query",
          required: false,
          schema: { type: "string", enum: ["user", "end_user", "shared"] },
          description: "Admin-only scope override. Defaults to caller's actor scope.",
        },
        {
          name: "actor_id",
          in: "query",
          required: false,
          schema: { type: "string" },
          description: "Required when `actor_type` is `user` or `end_user`.",
        },
        {
          name: "runId",
          in: "query",
          required: false,
          schema: { type: "string" },
          description: "Narrow `memories` and `pinned` to rows touched during a specific run.",
        },
      ],
      responses: {
        "200": {
          description: "Persistence rows",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  pinned: {
                    type: "array",
                    items: {
                      type: "object",
                      required: [
                        "id",
                        "key",
                        "content",
                        "runId",
                        "actor_type",
                        "actor_id",
                        "createdAt",
                        "updatedAt",
                      ],
                      properties: {
                        id: { type: "integer" },
                        key: { type: "string" },
                        content: {},
                        runId: { type: ["string", "null"] },
                        actor_type: { type: "string", enum: ["user", "end_user", "shared"] },
                        actor_id: { type: ["string", "null"] },
                        createdAt: { type: ["string", "null"], format: "date-time" },
                        updatedAt: { type: ["string", "null"], format: "date-time" },
                      },
                    },
                  },
                  memories: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["id", "content", "runId", "actor_type", "actor_id", "createdAt"],
                      properties: {
                        id: { type: "integer" },
                        content: { type: "string" },
                        runId: { type: ["string", "null"] },
                        actor_type: { type: "string", enum: ["user", "end_user", "shared"] },
                        actor_id: { type: ["string", "null"] },
                        createdAt: { type: ["string", "null"], format: "date-time" },
                        pinned: { type: "boolean" },
                      },
                    },
                  },
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
    delete: {
      operationId: "deleteAgentPersistence",
      tags: ["Agents"],
      summary: "Bulk-delete persistence rows for an agent",
      description:
        "Wipes memories (always) and optionally the `checkpoint` slot (when `actor_type` + `actor_id` resolve to a single scope). Other named pinned slots must be deleted individually via DELETE /persistence/pinned/{id}. Admin-only. Bulk mutation — returns a documented operation result with snake_case counts, not a 204 (issue #657).",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
        {
          name: "kind",
          in: "query",
          required: false,
          schema: { type: "string", enum: ["pinned", "memory"] },
        },
        {
          name: "actor_type",
          in: "query",
          required: false,
          schema: { type: "string", enum: ["user", "end_user", "shared"] },
        },
        {
          name: "actor_id",
          in: "query",
          required: false,
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": {
          description: "Counts of deleted rows",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["memories_deleted", "checkpoint_deleted"],
                properties: {
                  memories_deleted: {
                    type: "integer",
                    description: "Number of memory rows deleted",
                  },
                  checkpoint_deleted: {
                    type: "boolean",
                    description: "Whether the checkpoint slot was deleted",
                  },
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
  },
  "/api/agents/{scope}/{name}/persistence/memories/{id}": {
    delete: {
      operationId: "deleteAgentPersistenceMemory",
      tags: ["Agents"],
      summary: "Delete a single memory by id",
      description: "Admin-only. The id must belong to the targeted agent in the current app.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
        { name: "id", in: "path", required: true, schema: { type: "integer" } },
      ],
      responses: {
        "204": {
          description: "Memory deleted",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/agents/{scope}/{name}/persistence/pinned/{id}": {
    delete: {
      operationId: "deleteAgentPersistencePinnedSlot",
      tags: ["Agents"],
      summary: "Delete a single pinned slot by id",
      description:
        "Admin-only. Deletes any named pinned slot (`checkpoint`, `persona`, `goals`, …). The id must belong to the targeted agent in the current app.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
        { name: "id", in: "path", required: true, schema: { type: "integer" } },
      ],
      responses: {
        "204": {
          description: "Pinned slot deleted",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/agents/{scope}/{name}/model": {
    get: {
      operationId: "getAgentModel",
      tags: ["Agents"],
      summary: "Get agent model configuration",
      description: "Returns the LLM model override for an agent (null if using org default).",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
      ],
      responses: {
        "200": {
          description: "Agent model config",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  modelId: { type: ["string", "null"] },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    put: {
      operationId: "setAgentModel",
      tags: ["Agents"],
      summary: "Set agent model override",
      description:
        "Set a model override for this agent. Pass a model ID or null to revert to org default. The model ID must name a system model preset or an org model owned by the organization — unknown or cross-org IDs are rejected with 404.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["modelId"],
              properties: {
                modelId: {
                  type: ["string", "null"],
                  description: "Model ID or null to use org default",
                },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Agent model updated — returns the bare model-setting resource",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              // Bare model-setting resource — same shape as GET …/model,
              // no `success` scrap (#657).
              schema: {
                type: "object",
                required: ["modelId"],
                properties: {
                  modelId: { type: ["string", "null"] },
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
  },
  "/api/agents/{scope}/{name}/skills": {
    put: {
      operationId: "updateAgentSkills",
      tags: ["Agents"],
      summary: "Update linked skills",
      description: "Set the skill references for a user agent.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["skillIds"],
              properties: {
                skillIds: {
                  type: "array",
                  items: {
                    type: "string",
                    pattern: "^@[a-z0-9]([a-z0-9-]*[a-z0-9])?/[a-z0-9]([a-z0-9-]*[a-z0-9])?$",
                  },
                },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Skills updated",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                // The updated agent resource, bare (issue #657) — the new
                // skill references appear in `dependencies.skills`.
                $ref: "#/components/schemas/AgentDetail",
                description:
                  "The updated agent resource — same shape as the GET agent detail. The new skill references appear in `dependencies.skills`. No follow-up GET needed.",
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": {
          description: "Agent in use (one or more runs are running)",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
      },
    },
  },
  "/api/agents/{scope}/{name}/bundle": {
    get: {
      operationId: "exportAgentBundle",
      tags: ["Agents"],
      summary: "Export an agent as an .afps-bundle",
      description:
        "Streams a canonical multi-package .afps-bundle archive containing the agent and all its transitive dependencies. The archive is deterministic (byte-identical across calls with the same inputs) and carries per-file RECORD hashes plus a bundle-level SRI digest (also echoed in the `X-Bundle-Integrity` response header). Two modes: `?source=published` (default) exports the version installed for this application (falls back to the `latest` dist-tag, or pass `?version=` to pin); `?source=draft` bundles the agent's current draft state — used by the CLI's run-by-id flow to mirror the dashboard Run button on never-published agents. `?source=draft` cannot be combined with `?version=`.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
        {
          in: "query",
          name: "version",
          required: false,
          description:
            "Version to export — exact semver, dist-tag, or semver range. Defaults to the version currently installed for this application (falls back to the `latest` dist-tag). Mutually exclusive with `?source=draft`.",
          schema: { type: "string" },
        },
        {
          in: "query",
          name: "source",
          required: false,
          description:
            "Bundle source. `published` (default) exports a published version archive — reproducible and signable. `draft` bundles the agent's live draft state and resolves dependencies via the draft catalog — mirrors the dashboard Run button so the CLI can run never-published agents.",
          schema: { type: "string", enum: ["draft", "published"] },
        },
      ],
      responses: {
        "200": {
          description: "The .afps-bundle archive",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
            "Content-Disposition": {
              description: "Attachment filename for the downloaded archive",
              schema: { type: "string" },
            },
            "X-Bundle-Integrity": {
              description:
                "Bundle-level SRI digest (`sha256-<base64>`) over the canonical packages map — clients may compare this against a client-side recompute to validate the transfer without unzipping.",
              schema: { type: "string" },
            },
            "X-Bundle-Version": {
              description:
                'Resolved version label of the served bundle: a concrete semver for `source=published`, or `"draft"` for `source=draft`. Lets a CLI/runner attribute its run via `POST /api/runs/remote` `kind: "registry"` without parsing the manifest.',
              schema: { type: "string" },
            },
          },
          content: {
            "application/zip": {
              schema: { type: "string", format: "binary" },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "429": { $ref: "#/components/responses/RateLimited" },
      },
    },
  },
} as const;
