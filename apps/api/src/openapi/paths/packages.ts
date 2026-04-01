export const packagesPaths = {
  "/api/packages/import": {
    post: {
      operationId: "importPackage",
      tags: ["Packages"],
      summary: "Import a package from ZIP",
      description:
        "Import a package (flow, skill, tool, or provider) from a ZIP file. The ZIP must contain a valid manifest.json. Rate-limited to 10 requests/minute. Returns 409 if the target package has unpublished draft changes — re-submit with ?force=true to overwrite.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        {
          name: "force",
          in: "query",
          required: false,
          description:
            "Skip draft overwrite protection. Set to true to overwrite a package with unpublished changes.",
          schema: { type: "boolean" },
        },
      ],
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
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["packageId", "type"],
                properties: {
                  packageId: { type: "string", description: "The imported package ID" },
                  type: {
                    type: "string",
                    description: "Package type (flow/skill/tool/provider)",
                  },
                },
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "409": {
          description:
            "Package has unpublished draft changes that would be overwritten, or version exists with different content",
          content: {
            "application/json": {
              schema: {
                oneOf: [
                  {
                    type: "object",
                    required: ["error", "message", "details"],
                    properties: {
                      error: { type: "string", enum: ["DRAFT_OVERWRITE"] },
                      message: { type: "string" },
                      details: {
                        type: "object",
                        properties: {
                          packageId: { type: "string" },
                          draftVersion: { type: ["string", "null"] },
                        },
                      },
                    },
                  },
                  {
                    type: "object",
                    required: ["error", "message", "details"],
                    properties: {
                      error: { type: "string", enum: ["INTEGRITY_MISMATCH"] },
                      message: { type: "string" },
                      details: {
                        type: "object",
                        properties: {
                          packageId: { type: "string" },
                          version: { type: "string" },
                        },
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        "429": { $ref: "#/components/responses/RateLimited" },
      },
    },
  },
  "/api/packages/import-github": {
    post: {
      operationId: "importPackageFromGithub",
      tags: ["Packages"],
      summary: "Import a package from a GitHub URL",
      description:
        "Import a package (flow, skill, tool, or provider) from a public GitHub repository URL. The URL must point to a directory containing a valid manifest.json. Rate-limited to 10 requests/minute.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["url"],
              properties: {
                url: {
                  type: "string",
                  description:
                    "GitHub URL pointing to a repository or subdirectory (e.g. https://github.com/owner/repo/tree/main/path)",
                },
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Package imported",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["packageId", "type"],
                properties: {
                  packageId: { type: "string", description: "The imported package ID" },
                  type: {
                    type: "string",
                    description: "Package type (flow/skill/tool/provider)",
                  },
                },
              },
            },
          },
        },
        "400": {
          description:
            "Validation error or GitHub import error (invalid URL, repo too large, rate limited, etc.)",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["error", "message"],
                properties: {
                  error: {
                    type: "string",
                    enum: [
                      "VALIDATION_ERROR",
                      "INVALID_URL",
                      "NOT_FOUND",
                      "RATE_LIMITED",
                      "GITHUB_ERROR",
                      "REPO_TOO_LARGE",
                      "EMPTY_PATH",
                      "TOO_MANY_FILES",
                      "TOO_LARGE",
                      "FILE_TOO_LARGE",
                      "DOWNLOAD_FAILED",
                    ],
                  },
                  message: { type: "string" },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "409": {
          description:
            "Package has unpublished draft changes that would be overwritten, or version exists with different content",
          content: {
            "application/json": {
              schema: {
                oneOf: [
                  {
                    type: "object",
                    required: ["error", "message", "details"],
                    properties: {
                      error: { type: "string", enum: ["DRAFT_OVERWRITE"] },
                      message: { type: "string" },
                      details: {
                        type: "object",
                        properties: {
                          packageId: { type: "string" },
                          draftVersion: { type: ["string", "null"] },
                        },
                      },
                    },
                  },
                  {
                    type: "object",
                    required: ["error", "message", "details"],
                    properties: {
                      error: { type: "string", enum: ["INTEGRITY_MISMATCH"] },
                      message: { type: "string" },
                      details: {
                        type: "object",
                        properties: {
                          packageId: { type: "string" },
                          version: { type: "string" },
                        },
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        "429": { $ref: "#/components/responses/RateLimited" },
      },
    },
  },
  "/api/packages/{scope}/{name}/{version}/download": {
    get: {
      operationId: "downloadPackageVersion",
      tags: ["Packages"],
      summary: "Download a versioned package ZIP",
      description:
        "Download a specific version of a package as a ZIP file. Supports exact version, dist-tag, or semver range resolution. Rate-limited to 50 requests/minute.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        {
          name: "scope",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^@[a-z0-9][a-z0-9-]*$" },
        },
        { name: "name", in: "path", required: true, schema: { type: "string" } },
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
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/NotFound" },
        "429": { $ref: "#/components/responses/RateLimited" },
        "500": {
          description: "Integrity check failed",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
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
      description: "List all skills (system + org) in the organization.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      responses: {
        "200": {
          description: "Skill list",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
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
        "401": { $ref: "#/components/responses/Unauthorized" },
      },
    },
    post: {
      operationId: "createSkill",
      tags: ["Packages"],
      summary: "Create a skill",
      description: "Create a new skill in the organization packages.",
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
                  lockVersion: { type: "integer" },
                  message: { type: "string" },
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
  "/api/packages/skills/{scope}/{name}/versions/info": {
    get: {
      operationId: "getSkillVersionInfo",
      tags: ["Packages"],
      summary: "Get version info for a skill (latest published + draft)",
      description:
        "Returns the latest published version and the current draft version from the manifest.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        {
          name: "scope",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^@[a-z0-9][a-z0-9-]*$" },
          description: "Package scope (e.g. @my-org)",
        },
        {
          name: "name",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Package name",
        },
      ],
      responses: {
        "200": {
          description: "Version info",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  latestVersion: { type: ["string", "null"] },
                  draftVersion: { type: ["string", "null"] },
                },
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/packages/skills/{scope}/{name}/versions": {
    get: {
      operationId: "listSkillVersions",
      tags: ["Packages"],
      summary: "List skill versions",
      description: "List all published versions for a skill.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        {
          name: "scope",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^@[a-z0-9][a-z0-9-]*$" },
          description: "Package scope (e.g. @my-org)",
        },
        {
          name: "name",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Package name",
        },
      ],
      responses: {
        "200": {
          description: "Version list",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
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
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    post: {
      operationId: "createSkillVersion",
      tags: ["Packages"],
      summary: "Create a version from draft",
      description:
        "Create an immutable version snapshot from the current skill draft. Version is determined by the manifest version field unless overridden.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        {
          name: "scope",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^@[a-z0-9][a-z0-9-]*$" },
          description: "Package scope (e.g. @my-org)",
        },
        {
          name: "name",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Package name",
        },
      ],
      requestBody: {
        required: false,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                version: {
                  type: "string",
                  description: "Optional semver version override (e.g. from bump selector)",
                },
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Version created",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  id: { type: "integer" },
                  version: { type: "string" },
                  message: { type: "string" },
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
  "/api/packages/skills/{scope}/{name}/versions/{version}/restore": {
    post: {
      operationId: "restoreSkillVersion",
      tags: ["Packages"],
      summary: "Restore a skill version into the draft",
      description:
        "Restore a previously published version into the skill draft. Does not create a new version.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        {
          name: "scope",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^@[a-z0-9][a-z0-9-]*$" },
          description: "Package scope (e.g. @my-org)",
        },
        {
          name: "name",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Package name",
        },
        {
          name: "version",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Version to restore (exact, dist-tag, or semver range)",
        },
      ],
      responses: {
        "200": {
          description: "Version restored",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  message: { type: "string" },
                  restoredVersion: { type: "string" },
                  lockVersion: { type: "integer" },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": { description: "Concurrent modification" },
      },
    },
  },
  "/api/packages/skills/{scope}/{name}/versions/{version}": {
    get: {
      operationId: "getSkillVersionDetail",
      tags: ["Packages"],
      summary: "Get skill version detail",
      description:
        "Resolve a version query and return versioned skill data including content extracted from ZIP.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        {
          name: "scope",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^@[a-z0-9][a-z0-9-]*$" },
          description: "Package scope (e.g. @my-org)",
        },
        {
          name: "name",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Package name",
        },
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
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  id: { type: "integer" },
                  version: { type: "string" },
                  manifest: { $ref: "#/components/schemas/SkillManifest" },
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
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    delete: {
      operationId: "deleteSkillVersion",
      tags: ["Packages"],
      summary: "Delete a skill version",
      description:
        "Permanently delete a skill version. Reassigns affected dist-tags to the next best stable version.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        {
          name: "scope",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^@[a-z0-9][a-z0-9-]*$" },
          description: "Package scope (e.g. @my-org)",
        },
        {
          name: "name",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Package name",
        },
        { name: "version", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "204": {
          description: "Version deleted",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/packages/skills/{scope}/{name}": {
    get: {
      operationId: "getSkill",
      tags: ["Packages"],
      summary: "Get skill detail",
      description: "Get a skill's full details including content.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        {
          name: "scope",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^@[a-z0-9][a-z0-9-]*$" },
          description: "Package scope (e.g. @my-org)",
        },
        {
          name: "name",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Package name",
        },
      ],
      responses: {
        "200": {
          description: "Skill detail",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/OrgPackageItemDetail" },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    put: {
      operationId: "updateSkill",
      tags: ["Packages"],
      summary: "Update a skill",
      description:
        "Update a skill in the organization packages. Built-in skills cannot be modified.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        {
          name: "scope",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^@[a-z0-9][a-z0-9-]*$" },
          description: "Package scope (e.g. @my-org)",
        },
        {
          name: "name",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Package name",
        },
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
                  lockVersion: { type: "integer" },
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
    delete: {
      operationId: "deleteSkill",
      tags: ["Packages"],
      summary: "Delete a skill",
      description:
        "Delete a skill from the organization packages. Built-in skills cannot be deleted.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        {
          name: "scope",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^@[a-z0-9][a-z0-9-]*$" },
          description: "Package scope (e.g. @my-org)",
        },
        {
          name: "name",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Package name",
        },
      ],
      responses: {
        "204": {
          description: "Skill deleted",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": {
          description: "Skill is referenced by flows or required by other packages",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  error: {
                    type: "string",
                    enum: ["IN_USE", "DEPENDED_ON"],
                    description:
                      "IN_USE: referenced by flows. DEPENDED_ON: required by other packages.",
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
                    description: "Packages depending on this skill (for DEPENDED_ON)",
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  "/api/packages/tools": {
    get: {
      operationId: "listTools",
      tags: ["Packages"],
      summary: "List tools",
      description: "List all tools (system + org) in the organization.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      responses: {
        "200": {
          description: "Tool list",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  tools: {
                    type: "array",
                    items: { $ref: "#/components/schemas/OrgPackageItem" },
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
      operationId: "createTool",
      tags: ["Packages"],
      summary: "Create a tool",
      description: "Create a new tool in the organization packages.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["id", "content"],
              properties: {
                id: { type: "string", description: "Unique tool ID (kebab-case)" },
                name: { type: "string", description: "Display name (optional)" },
                description: { type: "string", description: "Tool description (optional)" },
                content: {
                  type: "string",
                  description:
                    "Tool TypeScript source (Pi SDK ExtensionFactory: export default function(pi: ExtensionAPI) { pi.registerTool(...) })",
                },
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Tool created",
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
                  lockVersion: { type: "integer" },
                  message: { type: "string" },
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
  "/api/packages/tools/{scope}/{name}/versions/info": {
    get: {
      operationId: "getToolVersionInfo",
      tags: ["Packages"],
      summary: "Get version info for a tool (latest published + draft)",
      description:
        "Returns the latest published version and the current draft version from the manifest.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        {
          name: "scope",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^@[a-z0-9][a-z0-9-]*$" },
          description: "Package scope (e.g. @my-org)",
        },
        {
          name: "name",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Package name",
        },
      ],
      responses: {
        "200": {
          description: "Version info",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  latestVersion: { type: ["string", "null"] },
                  draftVersion: { type: ["string", "null"] },
                },
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/packages/tools/{scope}/{name}/versions": {
    get: {
      operationId: "listToolVersions",
      tags: ["Packages"],
      summary: "List tool versions",
      description: "List all published versions for a tool.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        {
          name: "scope",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^@[a-z0-9][a-z0-9-]*$" },
          description: "Package scope (e.g. @my-org)",
        },
        {
          name: "name",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Package name",
        },
      ],
      responses: {
        "200": {
          description: "Version list",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
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
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    post: {
      operationId: "createToolVersion",
      tags: ["Packages"],
      summary: "Create a version from draft",
      description:
        "Create an immutable version snapshot from the current tool draft. Version is determined by the manifest version field unless overridden.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        {
          name: "scope",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^@[a-z0-9][a-z0-9-]*$" },
          description: "Package scope (e.g. @my-org)",
        },
        {
          name: "name",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Package name",
        },
      ],
      requestBody: {
        required: false,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                version: {
                  type: "string",
                  description: "Optional semver version override (e.g. from bump selector)",
                },
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Version created",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  id: { type: "integer" },
                  version: { type: "string" },
                  message: { type: "string" },
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
  "/api/packages/tools/{scope}/{name}/versions/{version}/restore": {
    post: {
      operationId: "restoreToolVersion",
      tags: ["Packages"],
      summary: "Restore a tool version into the draft",
      description:
        "Restore a previously published version into the tool draft. Does not create a new version.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        {
          name: "scope",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^@[a-z0-9][a-z0-9-]*$" },
          description: "Package scope (e.g. @my-org)",
        },
        {
          name: "name",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Package name",
        },
        {
          name: "version",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Version to restore (exact, dist-tag, or semver range)",
        },
      ],
      responses: {
        "200": {
          description: "Version restored",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  message: { type: "string" },
                  restoredVersion: { type: "string" },
                  lockVersion: { type: "integer" },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": { description: "Concurrent modification" },
      },
    },
  },
  "/api/packages/tools/{scope}/{name}/versions/{version}": {
    get: {
      operationId: "getToolVersionDetail",
      tags: ["Packages"],
      summary: "Get tool version detail",
      description:
        "Resolve a version query and return versioned tool data including content extracted from ZIP.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        {
          name: "scope",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^@[a-z0-9][a-z0-9-]*$" },
          description: "Package scope (e.g. @my-org)",
        },
        {
          name: "name",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Package name",
        },
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
          description: "Versioned tool detail",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  id: { type: "integer" },
                  version: { type: "string" },
                  manifest: { $ref: "#/components/schemas/ToolManifest" },
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
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    delete: {
      operationId: "deleteToolVersion",
      tags: ["Packages"],
      summary: "Delete a tool version",
      description:
        "Permanently delete a tool version. Reassigns affected dist-tags to the next best stable version.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        {
          name: "scope",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^@[a-z0-9][a-z0-9-]*$" },
          description: "Package scope (e.g. @my-org)",
        },
        {
          name: "name",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Package name",
        },
        { name: "version", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "204": {
          description: "Version deleted",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/packages/tools/{scope}/{name}": {
    get: {
      operationId: "getTool",
      tags: ["Packages"],
      summary: "Get tool detail",
      description: "Get a tool's full details including content.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        {
          name: "scope",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^@[a-z0-9][a-z0-9-]*$" },
          description: "Package scope (e.g. @my-org)",
        },
        {
          name: "name",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Package name",
        },
      ],
      responses: {
        "200": {
          description: "Tool detail",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/OrgPackageItemDetail" },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    put: {
      operationId: "updateTool",
      tags: ["Packages"],
      summary: "Update a tool",
      description: "Update a tool in the organization packages. Built-in tools cannot be modified.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        {
          name: "scope",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^@[a-z0-9][a-z0-9-]*$" },
          description: "Package scope (e.g. @my-org)",
        },
        {
          name: "name",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Package name",
        },
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
          description: "Tool updated",
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
                  lockVersion: { type: "integer" },
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
    delete: {
      operationId: "deleteTool",
      tags: ["Packages"],
      summary: "Delete a tool",
      description:
        "Delete a tool from the organization packages. Built-in tools cannot be deleted.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        {
          name: "scope",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^@[a-z0-9][a-z0-9-]*$" },
          description: "Package scope (e.g. @my-org)",
        },
        {
          name: "name",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Package name",
        },
      ],
      responses: {
        "204": {
          description: "Tool deleted",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": {
          description: "Tool is referenced by flows or required by other packages",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  error: {
                    type: "string",
                    enum: ["IN_USE", "DEPENDED_ON"],
                    description:
                      "IN_USE: referenced by flows. DEPENDED_ON: required by other packages.",
                  },
                  message: { type: "string" },
                  flows: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: { id: { type: "string" }, displayName: { type: "string" } },
                    },
                    description: "Flows referencing this tool (for IN_USE)",
                  },
                  dependents: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: { id: { type: "string" }, displayName: { type: "string" } },
                    },
                    description: "Packages depending on this tool (for DEPENDED_ON)",
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  "/api/packages/flows": {
    post: {
      operationId: "createFlow",
      tags: ["Packages"],
      summary: "Create a user flow",
      description:
        "Create a new user flow from manifest and content. Creates an initial version automatically.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["manifest", "content"],
              properties: {
                manifest: { $ref: "#/components/schemas/FlowManifest" },
                content: { type: "string", description: "Agent prompt (markdown)" },
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Flow created",
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
                  lockVersion: { type: "integer" },
                  message: { type: "string" },
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
  "/api/packages/flows/{scope}/{name}": {
    get: {
      operationId: "getFlowPackage",
      tags: ["Packages"],
      summary: "Get flow detail",
      description: "Returns flow detail including providers, config, state, skills, and tools.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        {
          name: "scope",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^@[a-z0-9][a-z0-9-]*$" },
          description: "Package scope (e.g. @my-org)",
        },
        {
          name: "name",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Package name",
        },
      ],
      responses: {
        "200": {
          description: "Flow detail",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  flow: { $ref: "#/components/schemas/FlowDetail" },
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
      operationId: "updateFlow",
      tags: ["Packages"],
      summary: "Update a user flow",
      description: "Update manifest and content of a user flow with optimistic locking.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        {
          name: "scope",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^@[a-z0-9][a-z0-9-]*$" },
          description: "Package scope (e.g. @my-org)",
        },
        {
          name: "name",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Package name",
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["manifest", "content", "lockVersion"],
              properties: {
                manifest: { $ref: "#/components/schemas/FlowManifest" },
                content: { type: "string" },
                lockVersion: { type: "integer", description: "Optimistic lock version" },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Flow updated",
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
                  lockVersion: { type: "integer" },
                },
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": { description: "Concurrent modification or flow in use" },
      },
    },
    delete: {
      operationId: "deleteFlow",
      tags: ["Packages"],
      summary: "Delete a user flow",
      description: "Delete a user flow. Built-in flows cannot be deleted.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        {
          name: "scope",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^@[a-z0-9][a-z0-9-]*$" },
          description: "Package scope (e.g. @my-org)",
        },
        {
          name: "name",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Package name",
        },
      ],
      responses: {
        "204": {
          description: "Flow deleted",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "409": { description: "Flow in use" },
      },
    },
  },
  "/api/packages/flows/{scope}/{name}/versions/info": {
    get: {
      operationId: "getFlowVersionInfo",
      tags: ["Packages"],
      summary: "Get flow version info (latest published + draft)",
      description: "Returns the latest published version and current draft version for a flow.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        {
          name: "scope",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^@[a-z0-9][a-z0-9-]*$" },
          description: "Package scope (e.g. @my-org)",
        },
        {
          name: "name",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Package name",
        },
      ],
      responses: {
        "200": {
          description: "Version info",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  latestVersion: { type: ["string", "null"] },
                  draftVersion: { type: ["string", "null"] },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/packages/flows/{scope}/{name}/versions": {
    get: {
      operationId: "listFlowVersions",
      tags: ["Packages"],
      summary: "List flow versions",
      description: "Returns all published versions for a flow.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        {
          name: "scope",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^@[a-z0-9][a-z0-9-]*$" },
          description: "Package scope (e.g. @my-org)",
        },
        {
          name: "name",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Package name",
        },
      ],
      responses: {
        "200": {
          description: "Version list",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
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
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    post: {
      operationId: "createFlowVersion",
      tags: ["Packages"],
      summary: "Create a flow version from draft",
      description:
        "Create an immutable version snapshot. Version is determined by the manifest version field unless overridden. Requires no running executions.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        {
          name: "scope",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^@[a-z0-9][a-z0-9-]*$" },
          description: "Package scope (e.g. @my-org)",
        },
        {
          name: "name",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Package name",
        },
      ],
      requestBody: {
        required: false,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                version: {
                  type: "string",
                  description: "Optional semver version override (e.g. from bump selector)",
                },
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Version created",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  id: { type: "integer" },
                  version: { type: "string" },
                  message: { type: "string" },
                },
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "409": { description: "Flow in use (running executions)" },
      },
    },
  },
  "/api/packages/flows/{scope}/{name}/versions/{version}/restore": {
    post: {
      operationId: "restoreFlowVersion",
      tags: ["Packages"],
      summary: "Restore a flow version into the draft",
      description: "Restore a published version into the draft. Requires no running executions.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        {
          name: "scope",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^@[a-z0-9][a-z0-9-]*$" },
          description: "Package scope (e.g. @my-org)",
        },
        {
          name: "name",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Package name",
        },
        { name: "version", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "Version restored",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  message: { type: "string" },
                  restoredVersion: { type: "string" },
                  lockVersion: { type: "integer" },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": { description: "Concurrent modification or flow in use" },
      },
    },
  },
  "/api/packages/flows/{scope}/{name}/versions/{version}": {
    get: {
      operationId: "getFlowVersionDetail",
      tags: ["Packages"],
      summary: "Get flow version detail",
      description: "Returns the detail of a specific flow version including manifest and content.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        {
          name: "scope",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^@[a-z0-9][a-z0-9-]*$" },
          description: "Package scope (e.g. @my-org)",
        },
        {
          name: "name",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Package name",
        },
        { name: "version", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "Version detail",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  id: { type: "integer" },
                  version: { type: "string" },
                  manifest: { $ref: "#/components/schemas/FlowManifest" },
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
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    delete: {
      operationId: "deleteFlowVersion",
      tags: ["Packages"],
      summary: "Delete a flow version",
      description:
        "Permanently delete a flow version. Reassigns affected dist-tags to the next best stable version. Blocked if executions are running.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        {
          name: "scope",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^@[a-z0-9][a-z0-9-]*$" },
          description: "Package scope (e.g. @my-org)",
        },
        {
          name: "name",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Package name",
        },
        { name: "version", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "204": {
          description: "Version deleted",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": {
          description: "Flow has running executions",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  error: { type: "string" },
                  message: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
  },
  "/api/packages/{scope}/{name}/fork": {
    post: {
      operationId: "forkPackage",
      tags: ["Packages"],
      summary: "Fork a package to your organization",
      description:
        "Create an editable copy of a non-owned package under the current organization's scope. The fork is based on the latest published version of the source package — the version manifest, content, and ZIP are copied. A local published version is automatically created. Returns 400 if the source has no published version.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        {
          name: "scope",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^@[a-z0-9][a-z0-9-]*$" },
          description: "Package scope (e.g. @other-org)",
        },
        {
          name: "name",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^[a-z0-9][a-z0-9-]*$" },
          description: "Package name",
        },
      ],
      requestBody: {
        required: false,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                name: {
                  type: "string",
                  pattern: "^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$",
                  description:
                    "Custom name for the forked package (slug format). Defaults to the source package name.",
                },
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Package forked successfully",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["packageId", "type", "forkedFrom"],
                properties: {
                  packageId: { type: "string", description: "New package ID under org scope" },
                  type: {
                    type: "string",
                    enum: ["flow", "skill", "tool", "provider"],
                  },
                  forkedFrom: { type: "string", description: "Source package ID" },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "400": {
          description: "Already owned, name collision, invalid name, or no published version",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  error: {
                    type: "string",
                    enum: [
                      "ALREADY_OWNED",
                      "NAME_COLLISION",
                      "INVALID_NAME",
                      "NO_PUBLISHED_VERSION",
                    ],
                  },
                  message: { type: "string" },
                },
              },
            },
          },
        },
        "403": {
          description: "Forbidden",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  error: { type: "string" },
                  message: { type: "string" },
                },
              },
            },
          },
        },
        "404": {
          description: "Package not found",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  error: { type: "string" },
                  message: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
  },

  // --- Packages — Providers ---

  "/api/packages/providers": {
    get: {
      operationId: "listProviderPackages",
      tags: ["Packages"],
      summary: "List provider packages",
      description: "List all provider packages (system + org) in the organization.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      responses: {
        "200": {
          description: "Provider package list",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  providers: {
                    type: "array",
                    items: { $ref: "#/components/schemas/OrgPackageItem" },
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
      operationId: "createProviderPackage",
      tags: ["Packages"],
      summary: "Create a provider package",
      description:
        "Create a new provider package from manifest and content. Creates an initial version automatically.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["manifest", "content"],
              properties: {
                manifest: { $ref: "#/components/schemas/ProviderManifest" },
                content: {
                  type: "string",
                  description: "Provider definition JSON (definition.json)",
                },
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Provider package created",
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
                  lockVersion: { type: "integer" },
                  message: { type: "string" },
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
  "/api/packages/providers/{scope}/{name}/versions/info": {
    get: {
      operationId: "getProviderPackageVersionInfo",
      tags: ["Packages"],
      summary: "Get version info for a provider package (latest published + draft)",
      description:
        "Returns the latest published version and the current draft version from the manifest.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        {
          name: "scope",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^@[a-z0-9][a-z0-9-]*$" },
          description: "Package scope (e.g. @my-org)",
        },
        {
          name: "name",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Package name",
        },
      ],
      responses: {
        "200": {
          description: "Version info",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  latestVersion: { type: ["string", "null"] },
                  draftVersion: { type: ["string", "null"] },
                },
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/packages/providers/{scope}/{name}/versions": {
    get: {
      operationId: "listProviderPackageVersions",
      tags: ["Packages"],
      summary: "List provider package versions",
      description: "List all published versions for a provider package.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        {
          name: "scope",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^@[a-z0-9][a-z0-9-]*$" },
          description: "Package scope (e.g. @my-org)",
        },
        {
          name: "name",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Package name",
        },
      ],
      responses: {
        "200": {
          description: "Version list",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
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
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    post: {
      operationId: "createProviderPackageVersion",
      tags: ["Packages"],
      summary: "Create a version from draft",
      description:
        "Create an immutable version snapshot from the current provider package draft. Version is determined by the manifest version field unless overridden.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        {
          name: "scope",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^@[a-z0-9][a-z0-9-]*$" },
          description: "Package scope (e.g. @my-org)",
        },
        {
          name: "name",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Package name",
        },
      ],
      requestBody: {
        required: false,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                version: {
                  type: "string",
                  description: "Optional semver version override (e.g. from bump selector)",
                },
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Version created",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  id: { type: "integer" },
                  version: { type: "string" },
                  message: { type: "string" },
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
  "/api/packages/providers/{scope}/{name}/versions/{version}/restore": {
    post: {
      operationId: "restoreProviderPackageVersion",
      tags: ["Packages"],
      summary: "Restore a provider package version into the draft",
      description:
        "Restore a previously published version into the provider package draft. Does not create a new version.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        {
          name: "scope",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^@[a-z0-9][a-z0-9-]*$" },
          description: "Package scope (e.g. @my-org)",
        },
        {
          name: "name",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Package name",
        },
        {
          name: "version",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Version to restore (exact, dist-tag, or semver range)",
        },
      ],
      responses: {
        "200": {
          description: "Version restored",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  message: { type: "string" },
                  restoredVersion: { type: "string" },
                  lockVersion: { type: "integer" },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": { description: "Concurrent modification" },
      },
    },
  },
  "/api/packages/providers/{scope}/{name}/versions/{version}": {
    get: {
      operationId: "getProviderPackageVersionDetail",
      tags: ["Packages"],
      summary: "Get provider package version detail",
      description:
        "Resolve a version query and return versioned provider data including content extracted from ZIP.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        {
          name: "scope",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^@[a-z0-9][a-z0-9-]*$" },
          description: "Package scope (e.g. @my-org)",
        },
        {
          name: "name",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Package name",
        },
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
          description: "Versioned provider detail",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  id: { type: "integer" },
                  version: { type: "string" },
                  manifest: { $ref: "#/components/schemas/ProviderManifest" },
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
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    delete: {
      operationId: "deleteProviderPackageVersion",
      tags: ["Packages"],
      summary: "Delete a provider package version",
      description:
        "Permanently delete a provider package version. Reassigns affected dist-tags to the next best stable version.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        {
          name: "scope",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^@[a-z0-9][a-z0-9-]*$" },
          description: "Package scope (e.g. @my-org)",
        },
        {
          name: "name",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Package name",
        },
        { name: "version", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "204": {
          description: "Version deleted",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/packages/providers/{scope}/{name}": {
    get: {
      operationId: "getProviderPackage",
      tags: ["Packages"],
      summary: "Get provider package detail",
      description: "Get a provider package's full details including content.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        {
          name: "scope",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^@[a-z0-9][a-z0-9-]*$" },
          description: "Package scope (e.g. @my-org)",
        },
        {
          name: "name",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Package name",
        },
      ],
      responses: {
        "200": {
          description: "Provider package detail",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/OrgPackageItemDetail" },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    put: {
      operationId: "updateProviderPackage",
      tags: ["Packages"],
      summary: "Update a provider package",
      description:
        "Update a provider package in the organization. Built-in providers cannot be modified.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        {
          name: "scope",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^@[a-z0-9][a-z0-9-]*$" },
          description: "Package scope (e.g. @my-org)",
        },
        {
          name: "name",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Package name",
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["manifest", "content", "lockVersion"],
              properties: {
                manifest: { $ref: "#/components/schemas/ProviderManifest" },
                content: { type: "string" },
                lockVersion: { type: "integer", description: "Optimistic lock version" },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Provider package updated",
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
                  lockVersion: { type: "integer" },
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
    delete: {
      operationId: "deleteProviderPackage",
      tags: ["Packages"],
      summary: "Delete a provider package",
      description:
        "Delete a provider package from the organization. Built-in providers cannot be deleted.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        {
          name: "scope",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^@[a-z0-9][a-z0-9-]*$" },
          description: "Package scope (e.g. @my-org)",
        },
        {
          name: "name",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Package name",
        },
      ],
      responses: {
        "204": {
          description: "Provider package deleted",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": { description: "Provider in use by flows" },
      },
    },
  },
} as const;
