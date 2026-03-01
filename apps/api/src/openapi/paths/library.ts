export const libraryPaths = {
  "/api/library/skills": {
    get: {
      operationId: "listSkills",
      tags: ["Library"],
      summary: "List skills",
      description: "List all skills (built-in + org) in the library.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      responses: {
        "200": {
          description: "Skill list",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  skills: {
                    type: "array",
                    items: { $ref: "#/components/schemas/OrgSkill" },
                  },
                },
              },
            },
          },
        },
      },
    },
    post: {
      operationId: "createSkill",
      tags: ["Library"],
      summary: "Create a skill",
      description: "Create a new skill in the organization library. Admin only.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["id", "content"],
              properties: {
                id: { type: "string", description: "Unique skill ID (kebab-case)" },
                name: {
                  type: "string",
                  description:
                    "Display name. Auto-extracted from SKILL.md YAML frontmatter if omitted.",
                },
                description: {
                  type: "string",
                  description:
                    "Skill description. Auto-extracted from SKILL.md YAML frontmatter if omitted.",
                },
                content: {
                  type: "string",
                  description: "SKILL.md content (markdown with YAML frontmatter)",
                },
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Skill created",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  skill: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      name: { type: "string" },
                      description: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
  },
  "/api/library/skills/{skillId}": {
    get: {
      operationId: "getSkill",
      tags: ["Library"],
      summary: "Get skill detail",
      description: "Get a skill's full details including content.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "skillId", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "Skill detail",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/OrgSkillDetail" },
            },
          },
        },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    put: {
      operationId: "updateSkill",
      tags: ["Library"],
      summary: "Update a skill",
      description:
        "Update a skill in the organization library. Built-in skills cannot be modified. Admin only.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "skillId", in: "path", required: true, schema: { type: "string" } },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                name: { type: "string" },
                description: { type: "string" },
                content: { type: "string" },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Skill updated",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  skill: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      name: { type: "string" },
                      description: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    delete: {
      operationId: "deleteSkill",
      tags: ["Library"],
      summary: "Delete a skill",
      description:
        "Delete a skill from the organization library. Built-in skills cannot be deleted. Admin only.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "skillId", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "204": { description: "Skill deleted" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": {
          description: "Skill is referenced by flows or required by marketplace packages",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  error: {
                    type: "string",
                    enum: ["IN_USE", "DEPENDED_ON"],
                    description:
                      "IN_USE: referenced by flows. DEPENDED_ON: required by marketplace packages.",
                  },
                  message: { type: "string" },
                  flows: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: { id: { type: "string" }, displayName: { type: "string" } },
                    },
                    description: "Flows referencing this skill (for IN_USE)",
                  },
                  dependents: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: { id: { type: "string" }, displayName: { type: "string" } },
                    },
                    description: "Marketplace packages depending on this skill (for DEPENDED_ON)",
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  "/api/library/extensions": {
    get: {
      operationId: "listExtensions",
      tags: ["Library"],
      summary: "List extensions",
      description: "List all extensions (built-in + org) in the library.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      responses: {
        "200": {
          description: "Extension list",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  extensions: {
                    type: "array",
                    items: { $ref: "#/components/schemas/OrgExtension" },
                  },
                },
              },
            },
          },
        },
      },
    },
    post: {
      operationId: "createExtension",
      tags: ["Library"],
      summary: "Create an extension",
      description: "Create a new extension in the organization library. Admin only.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["id", "content"],
              properties: {
                id: { type: "string", description: "Unique extension ID (kebab-case)" },
                name: { type: "string", description: "Display name (optional)" },
                description: { type: "string", description: "Extension description (optional)" },
                content: {
                  type: "string",
                  description:
                    "Extension TypeScript source (Pi SDK ExtensionFactory: export default function(pi: ExtensionAPI) { pi.registerTool(...) })",
                },
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Extension created",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  extension: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      name: { type: "string" },
                      description: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
  },
  "/api/library/extensions/{extensionId}": {
    get: {
      operationId: "getExtension",
      tags: ["Library"],
      summary: "Get extension detail",
      description: "Get an extension's full details including content.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "extensionId", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "Extension detail",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/OrgExtensionDetail" },
            },
          },
        },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    put: {
      operationId: "updateExtension",
      tags: ["Library"],
      summary: "Update an extension",
      description:
        "Update an extension in the organization library. Built-in extensions cannot be modified. Admin only.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "extensionId", in: "path", required: true, schema: { type: "string" } },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                name: { type: "string" },
                description: { type: "string" },
                content: { type: "string" },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Extension updated",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  extension: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      name: { type: "string" },
                      description: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    delete: {
      operationId: "deleteExtension",
      tags: ["Library"],
      summary: "Delete an extension",
      description:
        "Delete an extension from the organization library. Built-in extensions cannot be deleted. Admin only.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "extensionId", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "204": { description: "Extension deleted" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": {
          description: "Extension is referenced by flows or required by marketplace packages",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  error: {
                    type: "string",
                    enum: ["IN_USE", "DEPENDED_ON"],
                    description:
                      "IN_USE: referenced by flows. DEPENDED_ON: required by marketplace packages.",
                  },
                  message: { type: "string" },
                  flows: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: { id: { type: "string" }, displayName: { type: "string" } },
                    },
                    description: "Flows referencing this extension (for IN_USE)",
                  },
                  dependents: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: { id: { type: "string" }, displayName: { type: "string" } },
                    },
                    description:
                      "Marketplace packages depending on this extension (for DEPENDED_ON)",
                  },
                },
              },
            },
          },
        },
      },
    },
  },
} as const;
