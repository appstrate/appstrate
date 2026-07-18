// SPDX-License-Identifier: Apache-2.0

// ─────────────────────────────────────────────────────────────────────────────
// Mutation response schemas (issue #657)
//
// Mutating package endpoints return the affected resource BARE — the exact
// shape of the corresponding GET detail, `$ref`'d directly. No operation
// envelope: the optimistic-lock token (`lock_version`) and fork provenance
// (`forked_from`) are resource state and live INSIDE the detail DTOs.
// ─────────────────────────────────────────────────────────────────────────────

/** `POST /packages/{type}` → the created package resource, bare. */
function packageCreateResponseSchema(detailRef: string) {
  return {
    $ref: detailRef,
    description:
      "The created package resource — same shape as its GET detail. The resource carries `lock_version`, the optimistic-lock token to send with the next update. No follow-up GET needed.",
  };
}

/** `PUT /packages/{type}/...` → the updated package resource, bare. */
function packageUpdateResponseSchema(detailRef: string) {
  return {
    $ref: detailRef,
    description:
      "The updated package resource — same shape as its GET detail. The resource carries the NEW `lock_version` — read it back before the next edit. No follow-up GET needed.",
  };
}

/** `POST /packages/{type}/.../versions` → the created version resource, bare. */
function versionCreateResponseSchema() {
  return {
    $ref: "#/components/schemas/PackageVersionDetail",
    description:
      "The created version resource — same shape as the GET version detail (manifest, integrity, dist_tags, …). `id` (version row id) and `version` are part of the resource. No follow-up GET needed.",
  };
}

/**
 * `POST /packages/.../versions/{v}/restore` → the updated PACKAGE resource,
 * bare. A restore mutates the package draft, so the response is the package
 * detail (not the version detail): the restored version is reflected in the
 * resource's `version` / `manifest` / `content`, and the resource carries the
 * package's NEW `lock_version`.
 */
function versionRestoreResponseSchema(detailRef: string) {
  return {
    $ref: detailRef,
    description:
      "The updated package resource after the restore — same shape as the package GET detail. The restored version is reflected in `version` / `manifest` / `content`, and the resource carries the package's NEW `lock_version` — read it back before the next draft edit.",
  };
}

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
                    "`.afps-bundle` (preferred), `.afps`, or `.zip` archive — detected automatically via the bundle.json marker. May also be supplied under the `bundle` form field as an alias.",
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
              // CASING: this import-result envelope is snake_case throughout
              // (`root_package_id`, `root_version`, `imported[].version_id`),
              // matching the runtime serializer. `version_id`/`root_package_id`
              // therefore DIVERGE from the universal *Id camelCase carve-out used
              // by request-body `packageId` — a documented, intentional
              // divergence kept because spec==runtime is the hard invariant.
              schema: {
                type: "object",
                required: [
                  "imported",
                  "root_installed",
                  "root_package_id",
                  "root_version",
                  "warnings",
                ],
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
                        type: {
                          type: "string",
                          description:
                            "Package type (agent, skill, mcp-server, integration). Present on `inserted` entries only.",
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
                  warnings: {
                    type: "array",
                    items: { type: "string" },
                    description:
                      "Non-blocking install-time warnings (AFPS §7.7) — e.g. `connect.login` selector/criteria patterns the runtime engine cannot evaluate. Empty when nothing is degraded.",
                  },
                },
              },
            },
          },
        },
        "400": {
          description:
            "Validation error or a post-install/version-creation failure. RFC 9457 problem+json with `code` one of `validation_failed`, `invalid_request`, or `post_install_failed`.",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
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
        "Import a package (agent, skill, or integration) from a ZIP file. The ZIP must contain a valid manifest.json. The package scope does not need to match your organization; imported packages are owned by your org and remain editable regardless of their scope name. Rate-limited to 10 requests/minute. Returns 409 if the target package has unpublished draft changes — re-submit with ?force=true to overwrite.",
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
                  warnings: {
                    type: "array",
                    items: { type: "string" },
                    description:
                      "Non-blocking install warnings (e.g. connect.login engine-subset or _meta soft-fails). Present only when warnings were emitted.",
                  },
                },
              },
              example: { packageId: "@acme/email-sorter", type: "agent", version: "1.0.0" },
            },
          },
        },
        "400": {
          description:
            "Validation error or import failure. RFC 9457 problem+json with `code` one of `validation_failed`, `invalid_request`, `name_collision` (system package or existing identifier owned by another org), `type_mismatch` (existing package has a different type), `post_install_failed`, or a ZIP parse code (e.g. `missing_manifest`).",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "409": {
          description:
            "Package has unpublished draft changes that would be overwritten, the version exists with different content, or a skill already exists with identical content. RFC 9457 problem+json with `code` one of `draft_overwrite`, `integrity_mismatch`, or `skill_unchanged`.",
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
  "/api/packages/import-github": {
    post: {
      operationId: "importPackageFromGithub",
      tags: ["Packages"],
      summary: "Import a package from a GitHub URL",
      description:
        "Import a package (agent, skill, or integration) from a public GitHub repository URL. The URL must point to a directory containing a valid manifest.json. The package scope does not need to match your organization; imported packages are owned by your org and remain editable regardless of their scope name. Rate-limited to 10 requests/minute.",
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
                  warnings: {
                    type: "array",
                    items: { type: "string" },
                    description:
                      "Non-blocking install warnings (e.g. connect.login engine-subset or _meta soft-fails). Present only when warnings were emitted.",
                  },
                },
              },
            },
          },
        },
        "400": {
          description:
            "Validation error or GitHub import error (invalid URL, repo too large, rate limited, etc.) or an import failure after fetch. RFC 9457 problem+json. `code` is a GitHub-fetch code (`INVALID_URL`, `NOT_FOUND`, `RATE_LIMITED`, `GITHUB_ERROR`, `REPO_TOO_LARGE`, `EMPTY_PATH`, `TOO_MANY_FILES`, `TOO_LARGE`, `FILE_TOO_LARGE`, `DOWNLOAD_FAILED`), a validation code (`validation_failed`, `invalid_request`), or an import code (`name_collision`, `type_mismatch`, `post_install_failed`).",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "409": {
          description:
            "Package has unpublished draft changes that would be overwritten, the version exists with different content, or a skill already exists with identical content. RFC 9457 problem+json with `code` one of `draft_overwrite`, `integrity_mismatch`, or `skill_unchanged`.",
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
        { $ref: "#/components/parameters/PackageActiveFilter" },
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
                    created_by: "usr_cm3abc123",
                    used_by_agents: 2,
                    auto_installed: false,
                    forked_from: null,
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
              required: ["manifest"],
              properties: {
                manifest: {
                  type: "object",
                  additionalProperties: true,
                  description:
                    "Skill package manifest (AFPS). The package ID is derived from `manifest.name`.",
                },
                content: {
                  type: "string",
                  description: "SKILL.md content (markdown with YAML frontmatter).",
                },
                source_code: { type: "string", description: "Optional source code payload." },
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
              schema: packageCreateResponseSchema("#/components/schemas/OrgPackageItemDetail"),
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
                required: ["versions"],
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
              schema: versionCreateResponseSchema(),
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "409": {
          description:
            "No changes to snapshot, or version already published (immutable — bump the version). RFC 9457 problem+json with `code` one of `no_changes`, `version_exists`, `agent_in_use`, or `conflict`.",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
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
              schema: versionRestoreResponseSchema("#/components/schemas/OrgPackageItemDetail"),
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": {
          description: "Concurrent modification. RFC 9457 problem+json with `code` of `conflict`.",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
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
              schema: { $ref: "#/components/schemas/PackageVersionDetail" },
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
              required: ["manifest", "content", "lock_version"],
              properties: {
                manifest: {
                  type: "object",
                  additionalProperties: true,
                  description: "Package manifest",
                },
                content: { type: "string" },
                lock_version: { type: "integer", description: "Optimistic lock version" },
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
              schema: packageUpdateResponseSchema("#/components/schemas/OrgPackageItemDetail"),
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
          description:
            "Skill is referenced by agents or required by other packages. RFC 9457 problem+json with `code` of `in_use`.",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
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
        { $ref: "#/components/parameters/PackageActiveFilter" },
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
              schema: packageCreateResponseSchema("#/components/schemas/AgentDetail"),
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
        {
          name: "version",
          in: "query",
          required: false,
          schema: { type: "string" },
          description:
            "Which agent definition to project: `draft` (the live editor working copy), `published` (latest published), or a version spec (exact version, dist-tag, or semver range). **Omitting resolves the `draft`** (the editor default). A concrete version returns config / input / integrations / skills from that published manifest — the same definition the run executes (issue #770) — so the run-with-options modal stays consistent with the selected version. Ignored for system agents.",
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
              schema: packageUpdateResponseSchema("#/components/schemas/AgentDetail"),
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": {
          description:
            "Concurrent modification or agent in use. RFC 9457 problem+json with `code` one of `conflict`, `agent_in_use`, or `no_changes`.",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
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
        "404": { $ref: "#/components/responses/NotFound" },
        "409": {
          description: "Agent in use. RFC 9457 problem+json with `code` of `agent_in_use`.",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
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
                required: ["versions"],
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
              schema: versionCreateResponseSchema(),
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "409": {
          description:
            "Agent in use (runs in progress), no changes to snapshot, or version already published (immutable — bump the version). RFC 9457 problem+json with `code` one of `agent_in_use`, `no_changes`, `version_exists`, or `conflict`.",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
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
              schema: versionRestoreResponseSchema("#/components/schemas/AgentDetail"),
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": {
          description:
            "Concurrent modification or agent in use. RFC 9457 problem+json with `code` one of `conflict`, `agent_in_use`, or `no_changes`.",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
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
              schema: { $ref: "#/components/schemas/PackageVersionDetail" },
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
          description:
            "Agent has runs in progress. RFC 9457 problem+json with `code` of `agent_in_use`.",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
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
        "Create a copy of a package the org does not already own (e.g. a read-only system package) under the current organization's scope. Org-owned packages are editable in place regardless of their scope name, so forking is only needed for packages the org does not own. The fork is based on the latest published version of the source package — the version manifest, content, and ZIP are copied. A local published version is automatically created. Returns 400 if the source has no published version.",
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
                // The forked package resource, bare — same shape as the new
                // package's GET detail, selected by the source package type at
                // runtime (issue #657). Fields vary by type, so the response is
                // a `oneOf`. Fork provenance is resource state: `forked_from`
                // is part of both detail DTOs.
                oneOf: [
                  { $ref: "#/components/schemas/AgentDetail" },
                  { $ref: "#/components/schemas/OrgPackageItemDetail" },
                ],
                description:
                  "The forked package resource — same shape as the new package's GET detail (`AgentDetail` for agents, otherwise `OrgPackageItemDetail`). The resource's `id` is the new package ID under org scope and `forked_from` carries the source package ID. No follow-up GET needed.",
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "400": {
          description:
            "Already owned, name collision, unsupported type, or no published version. RFC 9457 problem+json with `code` one of `invalid_request` (already owned / no published version / unsupported type) or `name_collision`.",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
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
              required: ["manifest", "content", "lock_version"],
              properties: {
                manifest: {
                  type: "object",
                  additionalProperties: true,
                  description: "Package manifest",
                },
                content: { type: "string" },
                lock_version: { type: "integer", description: "Optimistic lock version" },
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
              schema: packageUpdateResponseSchema("#/components/schemas/OrgPackageItemDetail"),
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
          description:
            "Skill is referenced by agents or required by other packages. RFC 9457 problem+json with `code` of `in_use`.",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
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
              schema: packageUpdateResponseSchema("#/components/schemas/AgentDetail"),
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": {
          description:
            "Concurrent modification or agent in use. RFC 9457 problem+json with `code` one of `conflict`, `agent_in_use`, or `no_changes`.",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
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
        "404": { $ref: "#/components/responses/NotFound" },
        "409": {
          description: "Agent in use. RFC 9457 problem+json with `code` of `agent_in_use`.",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
      },
    },
  },
  // --- Integration package CRUD routes (registry packages, distinct from the
  //     /api/integrations connection domain) ---

  "/api/packages/integrations": {
    get: {
      operationId: "listIntegrationPackages",
      tags: ["Packages"],
      summary: "List integration packages",
      description: "List all integration packages (system + org) in the organization.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { $ref: "#/components/parameters/PackageActiveFilter" },
      ],
      responses: {
        "200": {
          description: "Integration package list",
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
      operationId: "createIntegrationPackage",
      tags: ["Packages"],
      summary: "Create an integration package",
      description: "Create a new integration package in the organization packages.",
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
              required: ["manifest"],
              properties: {
                manifest: {
                  type: "object",
                  additionalProperties: true,
                  description:
                    "Integration package manifest (AFPS). The package ID is derived from `manifest.name`.",
                },
                content: {
                  type: "string",
                  description: "Primary package file content (manifest document).",
                },
                source_code: {
                  type: "string",
                  description: "Optional source code payload for the integration runner.",
                },
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Integration package created",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: packageCreateResponseSchema("#/components/schemas/OrgPackageItemDetail"),
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
  },
  "/api/packages/integrations/{scope}/{name}/versions/info": {
    get: {
      operationId: "getIntegrationPackageVersionInfo",
      tags: ["Packages"],
      summary: "Get version info for an integration package (latest published + draft)",
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
  "/api/packages/integrations/{scope}/{name}/versions": {
    get: {
      operationId: "listIntegrationPackageVersions",
      tags: ["Packages"],
      summary: "List integration package versions",
      description: "List all published versions for an integration package.",
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
                required: ["versions"],
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
      operationId: "createIntegrationPackageVersion",
      tags: ["Packages"],
      summary: "Create a version from draft",
      description:
        "Create an immutable version snapshot from the current integration package draft. Version is determined by the manifest version field unless overridden.",
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
              schema: versionCreateResponseSchema(),
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "409": {
          description:
            "No changes to snapshot, or version already published (immutable — bump the version). RFC 9457 problem+json with `code` one of `no_changes`, `version_exists`, `agent_in_use`, or `conflict`.",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
      },
    },
  },
  "/api/packages/integrations/{scope}/{name}/versions/{version}/restore": {
    post: {
      operationId: "restoreIntegrationPackageVersion",
      tags: ["Packages"],
      summary: "Restore an integration package version into the draft",
      description:
        "Restore a previously published version into the integration package draft. Does not create a new version.",
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
              schema: versionRestoreResponseSchema("#/components/schemas/OrgPackageItemDetail"),
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": {
          description: "Concurrent modification. RFC 9457 problem+json with `code` of `conflict`.",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
      },
    },
  },
  "/api/packages/integrations/{scope}/{name}/versions/{version}": {
    get: {
      operationId: "getIntegrationPackageVersionDetail",
      tags: ["Packages"],
      summary: "Get integration package version detail",
      description:
        "Resolve a version query and return versioned integration package data including content extracted from ZIP.",
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
          description: "Versioned integration package detail",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/PackageVersionDetail" },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    delete: {
      operationId: "deleteIntegrationPackageVersion",
      tags: ["Packages"],
      summary: "Delete an integration package version",
      description:
        "Permanently delete an integration package version. Reassigns affected dist-tags to the next best stable version.",
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
  "/api/packages/integrations/{scope}/{name}": {
    get: {
      operationId: "getIntegrationPackage",
      tags: ["Packages"],
      summary: "Get integration package detail",
      description: "Get an integration package's full details including content.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
      ],
      responses: {
        "200": {
          description: "Integration package detail",
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
      operationId: "updateIntegrationPackage",
      tags: ["Packages"],
      summary: "Update an integration package",
      description:
        "Update an integration package in the organization packages. Built-in integration packages cannot be modified.",
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
                manifest: {
                  type: "object",
                  additionalProperties: true,
                  description: "Package manifest",
                },
                content: { type: "string" },
                lock_version: { type: "integer", description: "Optimistic lock version" },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Integration package updated",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: packageUpdateResponseSchema("#/components/schemas/OrgPackageItemDetail"),
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
      operationId: "deleteIntegrationPackage",
      tags: ["Packages"],
      summary: "Delete an integration package",
      description:
        "Delete an integration package from the organization packages. Built-in integration packages cannot be deleted.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
      ],
      responses: {
        "204": {
          description: "Integration package deleted",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": {
          description:
            "Integration package is referenced by agents or required by other packages. RFC 9457 problem+json with `code` of `in_use`.",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
      },
    },
  },
  "/api/packages/integrations/{id}": {
    get: {
      operationId: "getIntegrationPackageById",
      tags: ["Packages"],
      summary: "Get integration package detail by ID",
      description: "Get an integration package's full details by unscoped package ID.",
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
          description: "Integration package detail",
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
      operationId: "updateIntegrationPackageById",
      tags: ["Packages"],
      summary: "Update an integration package by ID",
      description:
        "Update an integration package by unscoped package ID. Built-in integration packages cannot be modified.",
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
                manifest: {
                  type: "object",
                  additionalProperties: true,
                  description: "Package manifest",
                },
                content: { type: "string" },
                lock_version: { type: "integer", description: "Optimistic lock version" },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Integration package updated",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: packageUpdateResponseSchema("#/components/schemas/OrgPackageItemDetail"),
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
      operationId: "deleteIntegrationPackageById",
      tags: ["Packages"],
      summary: "Delete an integration package by ID",
      description:
        "Delete an integration package by unscoped package ID. Built-in integration packages cannot be deleted.",
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
          description: "Integration package deleted",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": {
          description:
            "Integration package is referenced by agents or required by other packages. RFC 9457 problem+json with `code` of `in_use`.",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
      },
    },
  },
  // --- MCP-server package CRUD routes ---

  "/api/packages/mcp-servers": {
    get: {
      operationId: "listMcpServerPackages",
      tags: ["Packages"],
      summary: "List MCP-server packages",
      description: "List all MCP-server packages (system + org) in the organization.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { $ref: "#/components/parameters/PackageActiveFilter" },
      ],
      responses: {
        "200": {
          description: "MCP-server package list",
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
      operationId: "createMcpServerPackage",
      tags: ["Packages"],
      summary: "Create an MCP-server package",
      description: "Create a new MCP-server package in the organization packages.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
      ],
      requestBody: {
        required: true,
        description:
          "Upload a package ZIP (`multipart/form-data` with a `.afps`/`.zip` file — the package ID is derived from the file name), or post a JSON body. Parsed by `parsePackageUpload`.",
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
                    "Package archive (`.afps` or `.zip`). File name (sans extension) is the kebab-case package id.",
                },
              },
            },
          },
          "application/json": {
            schema: {
              type: "object",
              required: ["id", "content"],
              properties: {
                id: { type: "string", description: "Kebab-case package id." },
                content: { type: "string", description: "Primary package file content." },
                name: {
                  type: "string",
                  description: "Display name. Auto-extracted from the manifest if omitted.",
                },
                description: {
                  type: "string",
                  description: "Package description. Auto-extracted from the manifest if omitted.",
                },
                version: { type: "string", description: "Initial semver (optional)." },
                manifest: {
                  type: "object",
                  additionalProperties: true,
                  description: "Optional manifest object (stored as-is).",
                },
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "MCP-server package created",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: packageCreateResponseSchema("#/components/schemas/OrgPackageItemDetail"),
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
  },
  "/api/packages/mcp-servers/{scope}/{name}/versions/info": {
    get: {
      operationId: "getMcpServerPackageVersionInfo",
      tags: ["Packages"],
      summary: "Get version info for an MCP-server package (latest published + draft)",
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
  "/api/packages/mcp-servers/{scope}/{name}/versions": {
    get: {
      operationId: "listMcpServerPackageVersions",
      tags: ["Packages"],
      summary: "List MCP-server package versions",
      description: "List all published versions for an MCP-server package.",
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
                required: ["versions"],
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
      operationId: "createMcpServerPackageVersion",
      tags: ["Packages"],
      summary: "Create a version from draft",
      description:
        "Create an immutable version snapshot from the current MCP-server package draft. Version is determined by the manifest version field unless overridden.",
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
              schema: versionCreateResponseSchema(),
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "409": {
          description:
            "No changes to snapshot, or version already published (immutable — bump the version). RFC 9457 problem+json with `code` one of `no_changes`, `version_exists`, `agent_in_use`, or `conflict`.",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
      },
    },
  },
  "/api/packages/mcp-servers/{scope}/{name}/versions/{version}/restore": {
    post: {
      operationId: "restoreMcpServerPackageVersion",
      tags: ["Packages"],
      summary: "Restore an MCP-server package version into the draft",
      description:
        "Restore a previously published version into the MCP-server package draft. Does not create a new version.",
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
              schema: versionRestoreResponseSchema("#/components/schemas/OrgPackageItemDetail"),
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": {
          description: "Concurrent modification. RFC 9457 problem+json with `code` of `conflict`.",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
      },
    },
  },
  "/api/packages/mcp-servers/{scope}/{name}/versions/{version}": {
    get: {
      operationId: "getMcpServerPackageVersionDetail",
      tags: ["Packages"],
      summary: "Get MCP-server package version detail",
      description:
        "Resolve a version query and return versioned MCP-server package data including content extracted from ZIP.",
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
          description: "Versioned MCP-server package detail",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/PackageVersionDetail" },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    delete: {
      operationId: "deleteMcpServerPackageVersion",
      tags: ["Packages"],
      summary: "Delete an MCP-server package version",
      description:
        "Permanently delete an MCP-server package version. Reassigns affected dist-tags to the next best stable version.",
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
  "/api/packages/mcp-servers/{scope}/{name}": {
    get: {
      operationId: "getMcpServerPackage",
      tags: ["Packages"],
      summary: "Get MCP-server package detail",
      description: "Get an MCP-server package's full details including content.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
      ],
      responses: {
        "200": {
          description: "MCP-server package detail",
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
      operationId: "updateMcpServerPackage",
      tags: ["Packages"],
      summary: "Update an MCP-server package",
      description:
        "Update an MCP-server package in the organization packages. Built-in MCP-server packages cannot be modified.",
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
                manifest: {
                  type: "object",
                  additionalProperties: true,
                  description: "Package manifest",
                },
                content: { type: "string" },
                lock_version: { type: "integer", description: "Optimistic lock version" },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "MCP-server package updated",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: packageUpdateResponseSchema("#/components/schemas/OrgPackageItemDetail"),
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
      operationId: "deleteMcpServerPackage",
      tags: ["Packages"],
      summary: "Delete an MCP-server package",
      description:
        "Delete an MCP-server package from the organization packages. Built-in MCP-server packages cannot be deleted.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
      ],
      responses: {
        "204": {
          description: "MCP-server package deleted",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": {
          description:
            "MCP-server package is referenced by agents or required by other packages. RFC 9457 problem+json with `code` of `in_use`.",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
      },
    },
  },
  "/api/packages/mcp-servers/{id}": {
    get: {
      operationId: "getMcpServerPackageById",
      tags: ["Packages"],
      summary: "Get MCP-server package detail by ID",
      description: "Get an MCP-server package's full details by unscoped package ID.",
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
          description: "MCP-server package detail",
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
      operationId: "updateMcpServerPackageById",
      tags: ["Packages"],
      summary: "Update an MCP-server package by ID",
      description:
        "Update an MCP-server package by unscoped package ID. Built-in MCP-server packages cannot be modified.",
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
                manifest: {
                  type: "object",
                  additionalProperties: true,
                  description: "Package manifest",
                },
                content: { type: "string" },
                lock_version: { type: "integer", description: "Optimistic lock version" },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "MCP-server package updated",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: packageUpdateResponseSchema("#/components/schemas/OrgPackageItemDetail"),
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
      operationId: "deleteMcpServerPackageById",
      tags: ["Packages"],
      summary: "Delete an MCP-server package by ID",
      description:
        "Delete an MCP-server package by unscoped package ID. Built-in MCP-server packages cannot be deleted.",
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
          description: "MCP-server package deleted",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": {
          description:
            "MCP-server package is referenced by agents or required by other packages. RFC 9457 problem+json with `code` of `in_use`.",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
      },
    },
  },
} as const;
