// SPDX-License-Identifier: Apache-2.0

export const packagesPaths = {
  "/api/packages/import-bundle": {
    post: {
      operationId: "importBundle",
      tags: ["Packages"],
      summary: "Import a multi-package .afps-bundle",
      description:
        "Import a multi-package `.afps-bundle` archive (exported via `GET /api/agents/:scope/:name/bundle`). Also accepts a raw `.afps` archive, which is promoted to a bundle-of-one by resolving its transitive dependencies against the org registry. Every embedded package is registered in the org (or reused if a byte-identical version already exists), and the root is installed in the current application. Rate-limited to 10 requests/minute. Returns 409 with a `bundle_conflict` code if any embedded package conflicts with an existing one (same identity, different bytes, or owned by another org).",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
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
                  description:
                    ".afps-bundle (preferred) or .afps archive — detected automatically via the bundle.json marker.",
                },
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Bundle imported",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["imported", "root_installed", "root_package_id", "root_version"],
                properties: {
                  imported: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["identity", "status"],
                      properties: {
                        identity: {
                          type: "string",
                          description: "Bundle package identity (@scope/name@version)",
                        },
                        status: {
                          type: "string",
                          enum: ["inserted", "reused"],
                          description:
                            "`inserted` means the version is new; `reused` means the version already existed with matching integrity.",
                        },
                        version_id: {
                          type: ["integer", "null"],
                          description: "DB row id for the version; null for system packages.",
                        },
                      },
                    },
                  },
                  root_installed: {
                    type: "boolean",
                    description:
                      "Whether the root was installed in the calling application (false if it was already installed).",
                  },
                  root_package_id: { type: "string" },
                  root_version: { type: "string" },
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
            "One or more embedded packages collide with existing ones (same identity + different integrity, or owned by another org). Error code: `bundle_conflict`.",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
        "429": { $ref: "#/components/responses/RateLimited" },
      },
    },
  },
  "/api/packages/import": {
    post: {
      operationId: "importPackage",
      tags: ["Packages"],
      summary: "Import a package from ZIP",
      description:
        "Import a package (agent, skill, or integration) from a ZIP file. The ZIP must contain a valid manifest.json. The package scope does not need to match your organization — cross-org packages are imported read-only (fork to modify). Rate-limited to 10 requests/minute. Returns 409 if the target package has unpublished draft changes — re-submit with ?force=true to overwrite.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
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
                    description: "Package type (agent/skill/mcp-server/integration)",
                  },
                  version: {
                    type: "string",
                    description:
                      "Imported manifest version (semver). Omitted when the manifest carries no version field.",
                  },
                },
              },
              example: { packageId: "@acme/email-sorter", type: "agent", version: "1.0.0" },
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
                          active_version: { type: ["string", "null"] },
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
        "Import a package (agent, skill, or integration) from a public GitHub repository URL. The URL must point to a directory containing a valid manifest.json. The package scope does not need to match your organization — cross-org packages are imported read-only (fork to modify). Rate-limited to 10 requests/minute.",
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
                    description: "Package type (agent/skill/mcp-server/integration)",
                  },
                  version: {
                    type: "string",
                    description:
                      "Imported manifest version (semver). Omitted when the manifest carries no version field.",
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
                          active_version: { type: ["string", "null"] },
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
        { $ref: "#/components/parameters/XAppId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
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
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
      ],
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
                required: ["object", "data", "hasMore"],
                properties: {
                  object: { type: "string", enum: ["list"] },
                  data: {
                    type: "array",
                    items: { $ref: "#/components/schemas/OrgPackageItem" },
                  },
                  hasMore: { type: "boolean" },
                },
              },
              example: {
                object: "list",
                hasMore: false,
                data: [
                  {
                    id: "@acme/summarize",
                    name: "Summarize",
                    description: "Summarizes long text into key points",
                    source: "local",
                    version: "1.0.0",
                    createdAt: "2026-01-10T08:00:00Z",
                    updatedAt: "2026-01-10T08:00:00Z",
                  },
                ],
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
                  lock_version: { type: "integer" },
                  message: { type: "string" },
                },
              },
              example: {
                packageId: "@acme/summarize",
                lock_version: 1,
                message: "Skill created",
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
        { $ref: "#/components/parameters/XAppId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
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
                  latest_published_version: { type: ["string", "null"] },
                  active_version: { type: ["string", "null"] },
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
        { $ref: "#/components/parameters/XAppId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
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
                    items: { $ref: "#/components/schemas/AgentVersion" },
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
        { $ref: "#/components/parameters/XAppId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
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
        { $ref: "#/components/parameters/XAppId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
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
                  restored_version: { type: "string" },
                  lock_version: { type: "integer" },
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
        { $ref: "#/components/parameters/XAppId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
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
                  yanked_reason: { type: ["string", "null"] },
                  integrity: { type: "string" },
                  artifact_size: { type: "integer" },
                  createdAt: { type: ["string", "null"], format: "date-time" },
                  dist_tags: { type: "array", items: { type: "string" } },
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
        { $ref: "#/components/parameters/XAppId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
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
        { $ref: "#/components/parameters/XAppId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
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
              properties: {
                name: { type: "string", description: "Display name" },
                description: { type: "string" },
                content: { type: "string" },
                version: { type: "string", description: "Semver version (X.Y.Z)" },
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
                  lock_version: { type: "integer" },
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
        { $ref: "#/components/parameters/XAppId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
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
          description: "Skill is referenced by agents or required by other packages",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  error: {
                    type: "string",
                    enum: ["IN_USE", "DEPENDED_ON"],
                    description:
                      "IN_USE: referenced by agents. DEPENDED_ON: required by other packages.",
                  },
                  message: { type: "string" },
                  agents: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: { id: { type: "string" }, display_name: { type: "string" } },
                    },
                    description: "Agents referencing this skill (for IN_USE)",
                  },
                  dependents: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: { id: { type: "string" }, display_name: { type: "string" } },
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
  "/api/packages/agents": {
    get: {
      operationId: "listAgentPackages",
      tags: ["Packages"],
      summary: "List agent packages",
      description: "List all agent packages (system + org) in the organization.",
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
                    items: { $ref: "#/components/schemas/OrgPackageItem" },
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
    post: {
      operationId: "createAgent",
      tags: ["Packages"],
      summary: "Create a user agent",
      description:
        "Create a new user agent from manifest and content. Creates an initial version automatically.",
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
              required: ["manifest", "content"],
              properties: {
                manifest: { $ref: "#/components/schemas/AgentManifest" },
                content: { type: "string", description: "Agent prompt (markdown)" },
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Agent created",
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
                  lock_version: { type: "integer" },
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
  "/api/packages/agents/{scope}/{name}": {
    get: {
      operationId: "getAgentPackage",
      tags: ["Packages"],
      summary: "Get agent detail",
      description: "Returns agent detail including integrations, config, state, and skills.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
      ],
      responses: {
        "200": {
          description: "Agent detail",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/AgentDetail" },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    put: {
      operationId: "updateAgent",
      tags: ["Packages"],
      summary: "Update a user agent",
      description: "Update manifest and content of a user agent with optimistic locking.",
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
              required: ["manifest", "content", "lock_version"],
              properties: {
                manifest: { $ref: "#/components/schemas/AgentManifest" },
                content: { type: "string" },
                lock_version: { type: "integer", description: "Optimistic lock version" },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Agent updated",
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
                  lock_version: { type: "integer" },
                },
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": { description: "Concurrent modification or agent in use" },
      },
    },
    delete: {
      operationId: "deleteAgent",
      tags: ["Packages"],
      summary: "Delete a user agent",
      description: "Delete a user agent. Built-in agents cannot be deleted.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
      ],
      responses: {
        "204": {
          description: "Agent deleted",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "409": { description: "Agent in use" },
      },
    },
  },
  "/api/packages/agents/{scope}/{name}/versions/info": {
    get: {
      operationId: "getAgentVersionInfo",
      tags: ["Packages"],
      summary: "Get agent version info (latest published + draft)",
      description: "Returns the latest published version and current draft version for an agent.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
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
                  latest_published_version: { type: ["string", "null"] },
                  active_version: { type: ["string", "null"] },
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
  "/api/packages/agents/{scope}/{name}/versions": {
    get: {
      operationId: "listAgentVersions",
      tags: ["Packages"],
      summary: "List agent versions",
      description: "Returns all published versions for an agent.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
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
                    items: { $ref: "#/components/schemas/AgentVersion" },
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
      operationId: "createAgentVersion",
      tags: ["Packages"],
      summary: "Create an agent version from draft",
      description:
        "Create an immutable version snapshot. Version is determined by the manifest version field unless overridden. Requires no running runs.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
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
        "409": { description: "Agent in use (runs in progress)" },
      },
    },
  },
  "/api/packages/agents/{scope}/{name}/versions/{version}/restore": {
    post: {
      operationId: "restoreAgentVersion",
      tags: ["Packages"],
      summary: "Restore an agent version into the draft",
      description: "Restore a published version into the draft. Requires no runs in progress.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
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
                  restored_version: { type: "string" },
                  lock_version: { type: "integer" },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": { description: "Concurrent modification or agent in use" },
      },
    },
  },
  "/api/packages/agents/{scope}/{name}/versions/{version}": {
    get: {
      operationId: "getAgentVersionDetail",
      tags: ["Packages"],
      summary: "Get agent version detail",
      description: "Returns the detail of a specific agent version including manifest and content.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
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
                  manifest: { $ref: "#/components/schemas/AgentManifest" },
                  content: { type: ["string", "null"] },
                  yanked: { type: "boolean" },
                  yanked_reason: { type: ["string", "null"] },
                  integrity: { type: "string" },
                  artifact_size: { type: "integer" },
                  createdAt: { type: ["string", "null"], format: "date-time" },
                  dist_tags: { type: "array", items: { type: "string" } },
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
      operationId: "deleteAgentVersion",
      tags: ["Packages"],
      summary: "Delete an agent version",
      description:
        "Permanently delete an agent version. Reassigns affected dist-tags to the next best stable version. Blocked if runs are in progress.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
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
          description: "Agent has runs in progress",
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
        { $ref: "#/components/parameters/XAppId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
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
                  pattern: "^[a-z0-9]([a-z0-9-]*[a-z0-9])?$",
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
                required: ["packageId", "type", "forked_from"],
                properties: {
                  packageId: { type: "string", description: "New package ID under org scope" },
                  type: {
                    type: "string",
                    enum: ["agent", "skill", "mcp-server", "integration"],
                  },
                  forked_from: { type: "string", description: "Source package ID" },
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
  // --- By-ID routes (unscoped package identifiers) ---

  "/api/packages/skills/{id}": {
    get: {
      operationId: "getSkillById",
      tags: ["Packages"],
      summary: "Get skill detail by ID",
      description: "Get a skill's full details by unscoped package ID.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Package ID (unscoped)",
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
      operationId: "updateSkillById",
      tags: ["Packages"],
      summary: "Update a skill by ID",
      description: "Update a skill by unscoped package ID. Built-in skills cannot be modified.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Package ID (unscoped)",
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
                  lock_version: { type: "integer" },
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
      operationId: "deleteSkillById",
      tags: ["Packages"],
      summary: "Delete a skill by ID",
      description: "Delete a skill by unscoped package ID. Built-in skills cannot be deleted.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Package ID (unscoped)",
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
          description: "Skill is referenced by agents or required by other packages",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  error: {
                    type: "string",
                    enum: ["IN_USE", "DEPENDED_ON"],
                    description:
                      "IN_USE: referenced by agents. DEPENDED_ON: required by other packages.",
                  },
                  message: { type: "string" },
                  agents: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: { id: { type: "string" }, display_name: { type: "string" } },
                    },
                    description: "Agents referencing this skill (for IN_USE)",
                  },
                  dependents: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: { id: { type: "string" }, display_name: { type: "string" } },
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
  "/api/packages/agents/{id}": {
    get: {
      operationId: "getAgentPackageById",
      tags: ["Packages"],
      summary: "Get agent detail by ID",
      description:
        "Returns agent detail including integrations, config, state, and skills by unscoped package ID.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Package ID (unscoped)",
        },
      ],
      responses: {
        "200": {
          description: "Agent detail",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/AgentDetail" },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    put: {
      operationId: "updateAgentById",
      tags: ["Packages"],
      summary: "Update a user agent by ID",
      description:
        "Update manifest and content of a user agent with optimistic locking by unscoped package ID.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Package ID (unscoped)",
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["manifest", "content", "lock_version"],
              properties: {
                manifest: { $ref: "#/components/schemas/AgentManifest" },
                content: { type: "string" },
                lock_version: { type: "integer", description: "Optimistic lock version" },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Agent updated",
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
                  lock_version: { type: "integer" },
                },
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": { description: "Concurrent modification or agent in use" },
      },
    },
    delete: {
      operationId: "deleteAgentById",
      tags: ["Packages"],
      summary: "Delete a user agent by ID",
      description: "Delete a user agent by unscoped package ID. Built-in agents cannot be deleted.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Package ID (unscoped)",
        },
      ],
      responses: {
        "204": {
          description: "Agent deleted",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "409": { description: "Agent in use" },
      },
    },
  },
} as const;
