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
                properties: {
                  agents: {
                    type: "array",
                    items: { $ref: "#/components/schemas/AgentListItem" },
                  },
                },
              },
              example: {
                agents: [
                  {
                    id: "@acme/email-sorter",
                    displayName: "Email Sorter",
                    description: "Automatically sorts and labels incoming emails",
                    schemaVersion: "1.1",
                    author: "Acme Corp",
                    keywords: ["email", "automation"],
                    source: "local",
                    scope: "@acme",
                    version: "1.2.0",
                    type: "agent",
                    runningRuns: 1,
                    dependencies: {
                      providers: { "@appstrate/gmail": "^1.0.0" },
                      skills: {},
                      tools: {},
                    },
                  },
                  {
                    id: "@appstrate/code-reviewer",
                    displayName: "Code Reviewer",
                    description: "Reviews pull requests and suggests improvements",
                    schemaVersion: "1.1",
                    author: "Appstrate",
                    keywords: ["code", "review", "github"],
                    source: "system",
                    scope: "@appstrate",
                    version: "2.0.0",
                    type: "agent",
                    runningRuns: 0,
                    dependencies: {
                      providers: { "@appstrate/github": "^1.0.0" },
                      skills: { "@appstrate/summarize": "^1.0.0" },
                      tools: {},
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
          description: "Configuration saved",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  config: { type: "object" },
                  validation: { type: "object", properties: { valid: { type: "boolean" } } },
                },
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
          description: "Agent proxy updated",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: { type: "object", properties: { success: { type: "boolean" } } },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/agents/{scope}/{name}/memories": {
    get: {
      operationId: "listAgentMemories",
      tags: ["Agents"],
      summary: "List agent memories",
      description:
        "Returns accumulated memories for an agent (org-scoped, shared across all users).",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
      ],
      responses: {
        "200": {
          description: "Memory list",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  memories: {
                    type: "array",
                    items: { $ref: "#/components/schemas/AgentMemory" },
                  },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    delete: {
      operationId: "deleteAllAgentMemories",
      tags: ["Agents"],
      summary: "Delete all agent memories",
      description: "Delete all accumulated memories for an agent.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
      ],
      responses: {
        "200": {
          description: "Memories deleted",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  deleted: { type: "integer" },
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
  "/api/agents/{scope}/{name}/memories/{memoryId}": {
    delete: {
      operationId: "deleteAgentMemory",
      tags: ["Agents"],
      summary: "Delete a single agent memory",
      description: "Delete a specific memory by ID.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
        { name: "memoryId", in: "path", required: true, schema: { type: "integer" } },
      ],
      responses: {
        "200": {
          description: "Memory deleted",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  deleted: { type: "boolean" },
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
        "Set a model override for this agent. Pass a model ID or null to revert to org default.",
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
          description: "Agent model updated",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: { type: "object", properties: { success: { type: "boolean" } } },
            },
          },
        },
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
                type: "object",
                properties: {
                  packageId: { type: "string" },
                  skillIds: { type: "array", items: { type: "string" } },
                  message: { type: "string" },
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
  "/api/agents/{scope}/{name}/tools": {
    put: {
      operationId: "updateAgentTools",
      tags: ["Agents"],
      summary: "Update linked tools",
      description: "Set the tool references for a user agent.",
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
              required: ["toolIds"],
              properties: {
                toolIds: {
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
          description: "Tools updated",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  packageId: { type: "string" },
                  toolIds: { type: "array", items: { type: "string" } },
                  message: { type: "string" },
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
  "/api/agents/{scope}/{name}/provider-profiles": {
    get: {
      operationId: "getAgentProviderProfiles",
      tags: ["Agents"],
      summary: "Get per-provider profile overrides",
      description:
        "Returns the per-provider connection profile overrides for an agent. Each key is a provider ID mapped to a profile ID.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
      ],
      responses: {
        "200": {
          description: "Provider profile overrides",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  overrides: {
                    type: "object",
                    additionalProperties: { type: "string" },
                    description: "Map of provider ID to profile ID",
                  },
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
      operationId: "setAgentProviderProfile",
      tags: ["Agents"],
      summary: "Set a per-provider profile override",
      description: "Override the connection profile used for a specific provider in this agent.",
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
              required: ["providerId", "profileId"],
              properties: {
                providerId: { type: "string", minLength: 1 },
                profileId: { type: "string", format: "uuid" },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Provider profile override set",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: { type: "object", properties: { success: { type: "boolean" } } },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    delete: {
      operationId: "removeAgentProviderProfile",
      tags: ["Agents"],
      summary: "Remove a per-provider profile override",
      description:
        "Remove the connection profile override for a specific provider, reverting to the default profile.",
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
              required: ["providerId"],
              properties: {
                providerId: { type: "string", minLength: 1 },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Provider profile override removed",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: { type: "object", properties: { success: { type: "boolean" } } },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/agents/{scope}/{name}/app-profile": {
    put: {
      operationId: "setAgentAppProfile",
      tags: ["Agents"],
      summary: "Set app profile for an agent",
      description:
        "Set or clear the application-level connection profile for this agent. Pass a profile ID to set, or null to clear.",
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
              required: ["appProfileId"],
              properties: {
                appProfileId: {
                  type: ["string", "null"],
                  format: "uuid",
                  description: "App profile ID or null to clear",
                },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "App profile updated",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: { type: "object", properties: { success: { type: "boolean" } } },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/agents/{scope}/{name}/bundle": {
    get: {
      operationId: "exportAgentBundle",
      tags: ["Agents"],
      summary: "Export an agent as an .afps-bundle",
      description:
        "Streams a canonical multi-package .afps-bundle archive containing the agent and all its transitive dependencies at pinned versions. The archive is deterministic (byte-identical across calls with the same inputs) and carries per-file RECORD hashes plus a bundle-level SRI digest (also echoed in the `X-Bundle-Integrity` response header). By default exports the version installed for this application; pass `?version=` to pin to a different release or dist-tag.",
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
            "Version to export — exact semver, dist-tag, or semver range. Defaults to the version currently installed for this application (falls back to the `latest` dist-tag).",
          schema: { type: "string" },
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
          },
          content: {
            "application/zip": {
              schema: { type: "string", format: "binary" },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
} as const;
