/**
 * Flows paths — includes both flows.ts and user-flows.ts endpoints
 * since they share base paths (e.g. /api/flows/{flowId}).
 */
export const flowsPaths = {
  "/api/flows": {
    get: {
      operationId: "listFlows",
      tags: ["Flows"],
      summary: "List all flows",
      description:
        "Returns all flows (built-in + user-imported) with running execution counts. Requires `X-Org-Id` header for cookie auth.",
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
    post: {
      operationId: "createFlow",
      tags: ["Flows"],
      summary: "Create a user flow",
      description:
        "Create a new user flow from manifest and prompt. Admin only. Rate-limited to 10/min.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["manifest", "prompt"],
              properties: {
                manifest: { type: "object", description: "Flow manifest JSON" },
                prompt: { type: "string", description: "Agent prompt (markdown)" },
                skillIds: { type: "array", items: { type: "string" } },
                extensionIds: { type: "array", items: { type: "string" } },
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Flow created",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  flowId: { type: "string" },
                  message: { type: "string" },
                },
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "429": { $ref: "#/components/responses/RateLimited" },
      },
    },
  },
  "/api/flows/import": {
    post: {
      operationId: "importFlow",
      tags: ["Flows"],
      summary: "Import flow from ZIP",
      description:
        "Import a flow package from a ZIP file (multipart/form-data). Admin only. Rate-limited to 10/min.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      requestBody: {
        required: true,
        content: {
          "multipart/form-data": {
            schema: {
              type: "object",
              required: ["file"],
              properties: {
                file: { type: "string", format: "binary", description: "ZIP file" },
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Flow imported",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  flowId: { type: "string" },
                  message: { type: "string" },
                  skillsCreated: { type: "integer" },
                  skillsMatched: { type: "integer" },
                  extensionsCreated: { type: "integer" },
                  extensionsMatched: { type: "integer" },
                  warnings: { type: "array", items: { type: "string" } },
                },
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "429": { $ref: "#/components/responses/RateLimited" },
      },
    },
  },
  "/api/flows/{flowId}": {
    get: {
      operationId: "getFlow",
      tags: ["Flows"],
      summary: "Get flow detail",
      description: "Returns flow detail including services, config, state, skills, and extensions.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "flowId", in: "path", required: true, schema: { type: "string" } },
        {
          name: "profileId",
          in: "query",
          required: false,
          description:
            "Connection profile ID to use for resolving service statuses. Defaults to user's effective profile.",
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": {
          description: "Flow detail",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/FlowDetail" },
            },
          },
        },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    put: {
      operationId: "updateFlow",
      tags: ["Flows"],
      summary: "Update a user flow",
      description: "Update manifest, prompt, skills, and extensions of a user flow. Admin only.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "flowId", in: "path", required: true, schema: { type: "string" } },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["manifest", "prompt", "updatedAt"],
              properties: {
                manifest: { type: "object" },
                prompt: { type: "string" },
                updatedAt: { type: "string", format: "date-time" },
                skillIds: { type: "array", items: { type: "string" } },
                extensionIds: { type: "array", items: { type: "string" } },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Flow updated",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  flowId: { type: "string" },
                  message: { type: "string" },
                  updatedAt: { type: "string" },
                },
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": { description: "Flow in use (running executions)" },
      },
    },
    delete: {
      operationId: "deleteFlow",
      tags: ["Flows"],
      summary: "Delete a user flow",
      description: "Delete a user-imported flow. Built-in flows cannot be deleted. Admin only.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "flowId", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "204": { description: "Flow deleted" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "409": { description: "Flow in use" },
      },
    },
  },
  "/api/flows/{flowId}/config": {
    put: {
      operationId: "saveFlowConfig",
      tags: ["Flows"],
      summary: "Save flow configuration",
      description:
        "Save flow configuration values. Validated against manifest config schema. Admin only.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "flowId", in: "path", required: true, schema: { type: "string" } },
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
  "/api/flows/{flowId}/versions": {
    get: {
      operationId: "listFlowVersions",
      tags: ["Flows"],
      summary: "List flow versions",
      description: "List version history for a user flow (newest first).",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "flowId", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "Version list",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  versions: {
                    type: "array",
                    items: { $ref: "#/components/schemas/FlowVersion" },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  "/api/flows/{flowId}/package": {
    get: {
      operationId: "downloadFlowPackage",
      tags: ["Flows"],
      summary: "Download flow package",
      description: "Download the flow package as a ZIP file. User flows only.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "flowId", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "ZIP file",
          content: {
            "application/zip": {
              schema: { type: "string", format: "binary" },
            },
          },
        },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    put: {
      operationId: "uploadFlowPackage",
      tags: ["Flows"],
      summary: "Upload flow package",
      description: "Upload a new ZIP package for a user flow. Admin only.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "flowId", in: "path", required: true, schema: { type: "string" } },
      ],
      requestBody: {
        required: true,
        content: {
          "multipart/form-data": {
            schema: {
              type: "object",
              required: ["file", "updatedAt"],
              properties: {
                file: { type: "string", format: "binary", description: "ZIP file" },
                updatedAt: {
                  type: "string",
                  format: "date-time",
                  description: "Current updatedAt for optimistic concurrency",
                },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Package uploaded",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  flowId: { type: "string" },
                  message: { type: "string" },
                  updatedAt: { type: "string" },
                },
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": { description: "Stale updatedAt (concurrent edit conflict)" },
      },
    },
  },
  "/api/flows/{flowId}/services/{serviceId}/bind": {
    post: {
      operationId: "bindFlowService",
      tags: ["Flows"],
      summary: "Bind admin connection to service",
      description: "Bind the current admin user's connection for a flow service. Admin only.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "flowId", in: "path", required: true, schema: { type: "string" } },
        { name: "serviceId", in: "path", required: true, schema: { type: "string" } },
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
      operationId: "unbindFlowService",
      tags: ["Flows"],
      summary: "Unbind admin connection from service",
      description: "Remove the admin connection binding for a flow service. Admin only.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "flowId", in: "path", required: true, schema: { type: "string" } },
        { name: "serviceId", in: "path", required: true, schema: { type: "string" } },
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
  "/api/flows/{flowId}/profile": {
    put: {
      operationId: "setFlowProfile",
      tags: ["Flows"],
      summary: "Set flow profile override",
      description:
        "Override the connection profile used for this flow. The specified profile must belong to the authenticated user.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "flowId", in: "path", required: true, schema: { type: "string" } },
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
        { name: "flowId", in: "path", required: true, schema: { type: "string" } },
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
  "/api/flows/{flowId}/share-token": {
    post: {
      operationId: "createShareToken",
      tags: ["Flows"],
      summary: "Create a share token",
      description: "Generate a one-time public share link for the flow. Admin only.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "flowId", in: "path", required: true, schema: { type: "string" } },
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
  "/api/flows/{flowId}/proxy": {
    get: {
      operationId: "getFlowProxy",
      tags: ["Flows"],
      summary: "Get flow proxy configuration",
      description:
        "Returns the proxy configuration for a flow (override ID and resolution status).",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "flowId", in: "path", required: true, schema: { type: "string" } },
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
        { name: "flowId", in: "path", required: true, schema: { type: "string" } },
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
  "/api/flows/{flowId}/memories": {
    get: {
      operationId: "listFlowMemories",
      tags: ["Flows"],
      summary: "List flow memories",
      description: "Returns accumulated memories for a flow (org-scoped, shared across all users).",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "flowId", in: "path", required: true, schema: { type: "string" } },
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
        { name: "flowId", in: "path", required: true, schema: { type: "string" } },
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
  "/api/flows/{flowId}/memories/{memoryId}": {
    delete: {
      operationId: "deleteFlowMemory",
      tags: ["Flows"],
      summary: "Delete a single flow memory",
      description: "Delete a specific memory by ID. Admin only.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "flowId", in: "path", required: true, schema: { type: "string" } },
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
  "/api/flows/{flowId}/skills": {
    put: {
      operationId: "updateFlowSkills",
      tags: ["Flows"],
      summary: "Update linked skills",
      description: "Set the skill references for a user flow. Admin only.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "flowId", in: "path", required: true, schema: { type: "string" } },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["skillIds"],
              properties: {
                skillIds: { type: "array", items: { type: "string" } },
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
                  flowId: { type: "string" },
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
  "/api/flows/{flowId}/extensions": {
    put: {
      operationId: "updateFlowExtensions",
      tags: ["Flows"],
      summary: "Update linked extensions",
      description: "Set the extension references for a user flow. Admin only.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "flowId", in: "path", required: true, schema: { type: "string" } },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["extensionIds"],
              properties: {
                extensionIds: { type: "array", items: { type: "string" } },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Extensions updated",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  flowId: { type: "string" },
                  extensionIds: { type: "array", items: { type: "string" } },
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
