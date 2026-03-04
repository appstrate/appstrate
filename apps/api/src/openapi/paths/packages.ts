export const packagesPaths = {
  "/api/packages/import": {
    post: {
      operationId: "importPackage",
      tags: ["Packages"],
      summary: "Import a package from ZIP",
      description:
        "Import a package (flow, skill, or extension) from a ZIP file. The ZIP must contain a valid manifest.json. Admin only. Rate-limited to 10 requests/minute.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      requestBody: {
        required: true,
        content: {
          "multipart/form-data": {
            schema: {
              type: "object",
              required: ["file"],
              properties: {
                file: {
                  type: "string",
                  format: "binary",
                  description: "ZIP file containing the package",
                },
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Package imported",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["packageId", "type"],
                properties: {
                  packageId: { type: "string", description: "The imported package ID" },
                  type: { type: "string", description: "Package type (flow/skill/extension)" },
                },
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "429": { $ref: "#/components/responses/RateLimited" },
      },
    },
  },
  "/api/packages/{packageId}/{version}/download": {
    get: {
      operationId: "downloadPackageVersion",
      tags: ["Packages"],
      summary: "Download a versioned package ZIP",
      description:
        "Download a specific version of a package as a ZIP file. Supports exact version, dist-tag, or semver range resolution. Rate-limited to 50 requests/minute.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "packageId", in: "path", required: true, schema: { type: "string" } },
        {
          name: "version",
          in: "path",
          required: true,
          description: "Exact version, dist-tag (e.g. 'latest'), or semver range (e.g. '^1.0.0')",
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": {
          description: "ZIP file with integrity and disposition headers",
          headers: {
            "X-Integrity": {
              description: "SHA256 SRI hash of the artifact",
              schema: { type: "string" },
            },
            "X-Yanked": {
              description: "Present and set to 'true' if the version is yanked",
              schema: { type: "string" },
            },
            "Content-Disposition": {
              description: "Attachment filename in scope-name-version.zip format",
              schema: { type: "string" },
            },
          },
          content: {
            "application/zip": {
              schema: { type: "string", format: "binary" },
            },
          },
        },
        "404": { $ref: "#/components/responses/NotFound" },
        "429": { $ref: "#/components/responses/RateLimited" },
        "500": {
          description: "Integrity check failed",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Error" },
            },
          },
        },
      },
    },
  },
  "/api/packages/skills": {
    get: {
      operationId: "listSkills",
      tags: ["Packages"],
      summary: "List skills",
      description: "List all skills (built-in + org) in the organization.",
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
                    items: { $ref: "#/components/schemas/OrgPackageItem" },
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
      tags: ["Packages"],
      summary: "Create a skill",
      description: "Create a new skill in the organization packages. Admin only.",
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
  "/api/packages/skills/{skillId}/versions": {
    get: {
      operationId: "listSkillVersions",
      tags: ["Packages"],
      summary: "List skill versions",
      description: "List all published versions for a skill.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "skillId", in: "path", required: true, schema: { type: "string" } },
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
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/packages/skills/{skillId}/versions/{version}": {
    get: {
      operationId: "getSkillVersionDetail",
      tags: ["Packages"],
      summary: "Get skill version detail",
      description:
        "Resolve a version query and return versioned skill data including content extracted from ZIP.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "skillId", in: "path", required: true, schema: { type: "string" } },
        {
          name: "version",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Version query — exact version, dist-tag, or semver range",
        },
      ],
      responses: {
        "200": {
          description: "Versioned skill detail",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  id: { type: "integer" },
                  version: { type: "string" },
                  manifest: { type: "object" },
                  content: { type: ["string", "null"] },
                  yanked: { type: "boolean" },
                  yankedReason: { type: ["string", "null"] },
                  integrity: { type: "string" },
                  artifactSize: { type: "integer" },
                  createdAt: { type: ["string", "null"], format: "date-time" },
                  distTags: { type: "array", items: { type: "string" } },
                },
              },
            },
          },
        },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/packages/skills/{skillId}": {
    get: {
      operationId: "getSkill",
      tags: ["Packages"],
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
              schema: { $ref: "#/components/schemas/OrgPackageItemDetail" },
            },
          },
        },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    put: {
      operationId: "updateSkill",
      tags: ["Packages"],
      summary: "Update a skill",
      description:
        "Update a skill in the organization packages. Built-in skills cannot be modified. Admin only.",
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
                name: { type: "string", description: "Display name" },
                description: { type: "string" },
                content: { type: "string" },
                version: { type: "string", description: "Semver version (X.Y.Z)" },
                scopedName: {
                  type: "string",
                  description: "Registry scoped name (@scope/name)",
                },
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
        "400": { $ref: "#/components/responses/ValidationError" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    delete: {
      operationId: "deleteSkill",
      tags: ["Packages"],
      summary: "Delete a skill",
      description:
        "Delete a skill from the organization packages. Built-in skills cannot be deleted. Admin only.",
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
  "/api/packages/extensions": {
    get: {
      operationId: "listExtensions",
      tags: ["Packages"],
      summary: "List extensions",
      description: "List all extensions (built-in + org) in the organization.",
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
                    items: { $ref: "#/components/schemas/OrgPackageItem" },
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
      tags: ["Packages"],
      summary: "Create an extension",
      description: "Create a new extension in the organization packages. Admin only.",
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
  "/api/packages/extensions/{extensionId}/versions": {
    get: {
      operationId: "listExtensionVersions",
      tags: ["Packages"],
      summary: "List extension versions",
      description: "List all published versions for an extension.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "extensionId", in: "path", required: true, schema: { type: "string" } },
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
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/packages/extensions/{extensionId}/versions/{version}": {
    get: {
      operationId: "getExtensionVersionDetail",
      tags: ["Packages"],
      summary: "Get extension version detail",
      description:
        "Resolve a version query and return versioned extension data including content extracted from ZIP.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "extensionId", in: "path", required: true, schema: { type: "string" } },
        {
          name: "version",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Version query — exact version, dist-tag, or semver range",
        },
      ],
      responses: {
        "200": {
          description: "Versioned extension detail",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  id: { type: "integer" },
                  version: { type: "string" },
                  manifest: { type: "object" },
                  content: { type: ["string", "null"] },
                  yanked: { type: "boolean" },
                  yankedReason: { type: ["string", "null"] },
                  integrity: { type: "string" },
                  artifactSize: { type: "integer" },
                  createdAt: { type: ["string", "null"], format: "date-time" },
                  distTags: { type: "array", items: { type: "string" } },
                },
              },
            },
          },
        },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/packages/extensions/{extensionId}": {
    get: {
      operationId: "getExtension",
      tags: ["Packages"],
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
              schema: { $ref: "#/components/schemas/OrgPackageItemDetail" },
            },
          },
        },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    put: {
      operationId: "updateExtension",
      tags: ["Packages"],
      summary: "Update an extension",
      description:
        "Update an extension in the organization packages. Built-in extensions cannot be modified. Admin only.",
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
                name: { type: "string", description: "Display name" },
                description: { type: "string" },
                content: { type: "string" },
                version: { type: "string", description: "Semver version (X.Y.Z)" },
                scopedName: {
                  type: "string",
                  description: "Registry scoped name (@scope/name)",
                },
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
        "400": { $ref: "#/components/responses/ValidationError" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    delete: {
      operationId: "deleteExtension",
      tags: ["Packages"],
      summary: "Delete an extension",
      description:
        "Delete an extension from the organization packages. Built-in extensions cannot be deleted. Admin only.",
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
