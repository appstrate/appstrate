/**
 * Flows paths — includes both flows.ts and user-flows.ts endpoints
 * since they share base paths (e.g. /api/flows/{scope}/{name}).
 */
export const flowsPaths = {
  "/api/flows": {
    get: {
      operationId: "listFlows",
      tags: ["Flows"],
      summary: "List all flows",
      description:
        "Returns all flows (system + user-imported) with running execution counts. Requires `X-Org-Id` header for cookie auth.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      responses: {
        "200": {
          description: "Flow list",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  flows: {
                    type: "array",
                    items: { $ref: "#/components/schemas/FlowListItem" },
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
  "/api/flows/{scope}/{name}/config": {
    put: {
      operationId: "saveFlowConfig",
      tags: ["Flows"],
      summary: "Save flow configuration",
      description:
        "Save flow configuration values. Validated against manifest config schema. Admin only.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "scope", in: "path", required: true, schema: { type: "string" } },
        { name: "name", in: "path", required: true, schema: { type: "string" } },
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
      },
    },
  },
  "/api/flows/{scope}/{name}/providers/{svcScope}/{svcName}/bind": {
    post: {
      operationId: "bindFlowProvider",
      tags: ["Flows"],
      summary: "Bind admin connection to provider",
      description: "Bind the current admin user's connection for a flow provider. Admin only.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "scope", in: "path", required: true, schema: { type: "string" } },
        { name: "name", in: "path", required: true, schema: { type: "string" } },
        { name: "svcScope", in: "path", required: true, schema: { type: "string" } },
        { name: "svcName", in: "path", required: true, schema: { type: "string" } },
      ],
      requestBody: {
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                profileId: { type: "string", description: "Optional connection profile ID" },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Admin connection bound",
          content: {
            "application/json": {
              schema: { type: "object", properties: { bound: { type: "boolean" } } },
            },
          },
        },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    delete: {
      operationId: "unbindFlowProvider",
      tags: ["Flows"],
      summary: "Unbind admin connection from provider",
      description: "Remove the admin connection binding for a flow provider. Admin only.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "scope", in: "path", required: true, schema: { type: "string" } },
        { name: "name", in: "path", required: true, schema: { type: "string" } },
        { name: "svcScope", in: "path", required: true, schema: { type: "string" } },
        { name: "svcName", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "Admin connection unbound",
          content: {
            "application/json": {
              schema: { type: "object", properties: { unbound: { type: "boolean" } } },
            },
          },
        },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
  },
  "/api/flows/{scope}/{name}/profile": {
    put: {
      operationId: "setFlowProfile",
      tags: ["Flows"],
      summary: "Set flow profile override",
      description:
        "Override the connection profile used for this flow. The specified profile must belong to the authenticated user.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "scope", in: "path", required: true, schema: { type: "string" } },
        { name: "name", in: "path", required: true, schema: { type: "string" } },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["profileId"],
              properties: {
                profileId: { type: "string", format: "uuid" },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Profile override set",
          content: {
            "application/json": {
              schema: { type: "object", properties: { success: { type: "boolean" } } },
            },
          },
        },
      },
    },
    delete: {
      operationId: "clearFlowProfile",
      tags: ["Flows"],
      summary: "Clear flow profile override",
      description: "Remove the per-flow profile override, reverting to the user's default profile.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "scope", in: "path", required: true, schema: { type: "string" } },
        { name: "name", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "Profile override cleared",
          content: {
            "application/json": {
              schema: { type: "object", properties: { success: { type: "boolean" } } },
            },
          },
        },
      },
    },
  },
  "/api/flows/{scope}/{name}/share-token": {
    post: {
      operationId: "createShareToken",
      tags: ["Flows"],
      summary: "Create a share token",
      description: "Generate a one-time public share link for the flow. Admin only.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "scope", in: "path", required: true, schema: { type: "string" } },
        { name: "name", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "Share token created",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  token: { type: "string" },
                  expiresAt: { type: "string", format: "date-time" },
                },
              },
            },
          },
        },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
  },
  "/api/flows/{scope}/{name}/proxy": {
    get: {
      operationId: "getFlowProxy",
      tags: ["Flows"],
      summary: "Get flow proxy configuration",
      description:
        "Returns the proxy configuration for a flow (override ID and resolution status).",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "scope", in: "path", required: true, schema: { type: "string" } },
        { name: "name", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "Flow proxy config",
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
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    put: {
      operationId: "setFlowProxy",
      tags: ["Flows"],
      summary: "Set flow proxy override",
      description:
        'Set a proxy override for this flow. Pass a proxy ID, "none" to disable proxying, or null to use org default. Admin only.',
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "scope", in: "path", required: true, schema: { type: "string" } },
        { name: "name", in: "path", required: true, schema: { type: "string" } },
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
          description: "Flow proxy updated",
          content: {
            "application/json": {
              schema: { type: "object", properties: { success: { type: "boolean" } } },
            },
          },
        },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/flows/{scope}/{name}/memories": {
    get: {
      operationId: "listFlowMemories",
      tags: ["Flows"],
      summary: "List flow memories",
      description: "Returns accumulated memories for a flow (org-scoped, shared across all users).",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "scope", in: "path", required: true, schema: { type: "string" } },
        { name: "name", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "Memory list",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  memories: {
                    type: "array",
                    items: { $ref: "#/components/schemas/FlowMemory" },
                  },
                },
              },
            },
          },
        },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    delete: {
      operationId: "deleteAllFlowMemories",
      tags: ["Flows"],
      summary: "Delete all flow memories",
      description: "Delete all accumulated memories for a flow. Admin only.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "scope", in: "path", required: true, schema: { type: "string" } },
        { name: "name", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "Memories deleted",
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
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/flows/{scope}/{name}/memories/{memoryId}": {
    delete: {
      operationId: "deleteFlowMemory",
      tags: ["Flows"],
      summary: "Delete a single flow memory",
      description: "Delete a specific memory by ID. Admin only.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "scope", in: "path", required: true, schema: { type: "string" } },
        { name: "name", in: "path", required: true, schema: { type: "string" } },
        { name: "memoryId", in: "path", required: true, schema: { type: "integer" } },
      ],
      responses: {
        "200": {
          description: "Memory deleted",
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
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/flows/{scope}/{name}/model": {
    get: {
      operationId: "getFlowModel",
      tags: ["Flows"],
      summary: "Get flow model configuration",
      description: "Returns the LLM model override for a flow (null if using org default).",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "scope", in: "path", required: true, schema: { type: "string" } },
        { name: "name", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "Flow model config",
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
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    put: {
      operationId: "setFlowModel",
      tags: ["Flows"],
      summary: "Set flow model override",
      description:
        "Set a model override for this flow. Pass a model ID or null to revert to org default. Admin only.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "scope", in: "path", required: true, schema: { type: "string" } },
        { name: "name", in: "path", required: true, schema: { type: "string" } },
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
          description: "Flow model updated",
          content: {
            "application/json": {
              schema: { type: "object", properties: { success: { type: "boolean" } } },
            },
          },
        },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/flows/{scope}/{name}/skills": {
    put: {
      operationId: "updateFlowSkills",
      tags: ["Flows"],
      summary: "Update linked skills",
      description: "Set the skill references for a user flow. Admin only.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "scope", in: "path", required: true, schema: { type: "string" } },
        { name: "name", in: "path", required: true, schema: { type: "string" } },
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
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/flows/{scope}/{name}/tools": {
    put: {
      operationId: "updateFlowTools",
      tags: ["Flows"],
      summary: "Update linked tools",
      description: "Set the tool references for a user flow. Admin only.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "scope", in: "path", required: true, schema: { type: "string" } },
        { name: "name", in: "path", required: true, schema: { type: "string" } },
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
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
} as const;
