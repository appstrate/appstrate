// SPDX-License-Identifier: Apache-2.0

import { STD_RESPONSE_HEADERS, REQUEST_ID_ONLY_HEADERS } from "../headers.ts";

/**
 * Shared tail of the four per-type list descriptions (skills / agents /
 * integrations / mcp-servers) — only the leading noun differs.
 */
const listPackagesSharedDescription =
  "system packages, plus organization packages installed in this space. " +
  "Organization packages that exist but are not installed here are NOT returned — for " +
  "the organization-wide catalogue with per-space install state, use " +
  "`GET /api/library`.";

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

/**
 * The authority sentence EVERY mutation of an EXISTING package carries — five
 * verbs (draft update, delete, version create, version restore, version delete)
 * times four types, twenty descriptions off ONE definition. Same reason
 * `PACKAGE_HOME_PROPERTIES` (`../schemas.ts`) is one object rather than four
 * copies: the rule is single (`packages.home_space_id`, RBAC spec §6.9) and
 * hand-copied prose drifts the moment it changes. It answered nothing at all
 * before — a reader could not tell from these descriptions that the space in
 * `X-Space-Id` is not what authorizes them.
 */
const PACKAGE_MUTATION_AUTHORITY =
  " **Authority is the package's HOME space** (`packages.home_space_id`, RBAC spec §6.9): this route requires the package type's `write` (`delete` for a delete) THERE and nowhere else — not in the space the request is made from, which merely consumes an installation and has no say over the draft, the versions or the identity. A `null` home is the organization catalog: owners and admins on a session, never an API key. An id the caller cannot READ at all answers 404 rather than 403, so this is not an existence oracle. Move the home with `PATCH /api/packages/{scope}/{name}`.";

export const packagesPaths = {
  "/api/packages/import-bundle": {
    post: {
      operationId: "importBundle",
      tags: ["Packages"],
      summary: "Import a multi-package .afps-bundle",
      description:
        "Import a multi-package `.afps-bundle` archive (exported via `GET /api/agents/:scope/:name/bundle`). Also accepts a raw `.afps` archive, which is promoted to a bundle-of-one by resolving its transitive dependencies against the org registry. Every embedded package is registered in the org (or reused if a byte-identical version already exists), and the root is installed in the current space. Rate-limited to 10 requests/minute. Returns 409 with a `bundle_conflict` code if any embedded package conflicts with an existing one (same identity, different bytes, or owned by another org).",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
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
                    "`.afps-bundle` (preferred), `.afps`, or `.zip` archive — detected automatically via the bundle.json marker.",
                },
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Bundle imported",
          headers: STD_RESPONSE_HEADERS,
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
                      "Whether the root was installed in the calling space (false if it was already installed).",
                  },
                  root_package_id: { type: "string" },
                  root_version: { type: "string" },
                  warnings: {
                    type: "array",
                    items: { type: "string" },
                    description:
                      "Non-blocking install-time warnings (AFPS §7.7) — e.g. `connect.login` selector/criteria patterns the runtime engine cannot evaluate, or an agent `timeout` above this deployment's ceiling. Empty when nothing is degraded.",
                  },
                },
              },
            },
          },
        },
        "400": {
          description:
            "Validation error or a post-install/version-creation failure. RFC 9457 problem+json with `code` one of `validation_failed`, `invalid_request`, or `post_install_failed`. A skill whose SKILL.md violates AFPS §3.3 answers `validation_failed` with the offending rule as the first `errors[]` entry's `code`; for a bundle the rule applies to the ROOT package only, never to a carried dependency copy.",
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
        { $ref: "#/components/parameters/XSpaceId" },
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
          headers: STD_RESPONSE_HEADERS,
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
                      "Non-blocking install warnings (e.g. connect.login engine-subset, _meta soft-fails, or an agent `timeout` above this deployment's ceiling). Present only when warnings were emitted.",
                  },
                },
              },
              example: { packageId: "@acme/email-sorter", type: "agent", version: "1.0.0" },
            },
          },
        },
        "400": {
          description:
            "Validation error or import failure. RFC 9457 problem+json with `code` one of `validation_failed`, `invalid_request`, `name_collision` (system package or existing identifier owned by another org), `type_mismatch` (existing package has a different type), `post_install_failed`, or a ZIP parse code (e.g. `missing_manifest`). A skill whose SKILL.md violates AFPS §3.3 answers `validation_failed` with the offending rule as the first `errors[]` entry's `code`; for a bundle the rule applies to the ROOT package only, never to a carried dependency copy.",
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
        { $ref: "#/components/parameters/XSpaceId" },
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
              additionalProperties: false,
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Package imported",
          headers: STD_RESPONSE_HEADERS,
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
                      "Non-blocking install warnings (e.g. connect.login engine-subset, _meta soft-fails, or an agent `timeout` above this deployment's ceiling). Present only when warnings were emitted.",
                  },
                },
              },
            },
          },
        },
        "400": {
          description:
            "Validation error or GitHub import error (invalid URL, repo too large, rate limited, etc.) or an import failure after fetch. RFC 9457 problem+json. `code` is a GitHub-fetch code (`INVALID_URL`, `NOT_FOUND`, `RATE_LIMITED`, `GITHUB_ERROR`, `REPO_TOO_LARGE`, `EMPTY_PATH`, `TOO_MANY_FILES`, `TOO_LARGE`, `FILE_TOO_LARGE`, `DOWNLOAD_FAILED`), a validation code (`validation_failed`, `invalid_request`), or an import code (`name_collision`, `type_mismatch`, `post_install_failed`). A skill whose SKILL.md violates AFPS §3.3 answers `validation_failed` with the offending rule as the first `errors[]` entry's `code`; for a bundle the rule applies to the ROOT package only, never to a carried dependency copy.",
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
  "/api/packages/{scope}/{name}/files": {
    get: {
      operationId: "listPackageFiles",
      tags: ["Packages"],
      summary: "List the files in a package artifact",
      description:
        "Flat index of every file in the package artifact — one entry per real file, sorted by `path`; " +
        "directories are not synthesized. Text files up to 1 MiB carry their full content in `inline` " +
        "while the response's cumulative inline budget lasts; `inline` is never a truncated prefix, so an " +
        "entry without it must be fetched from `GET /api/packages/{scope}/{name}/files/content`. " +
        "Read-only. Rate-limited to 50 requests/minute.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
        {
          name: "version",
          in: "query",
          required: false,
          schema: { type: "string" },
          description:
            "Which snapshot to read: omitted (or `draft`) reads the live draft, where the stored artifact is overlaid with the authoritative `manifest.json` / primary content from the database. Any other value is resolved as a version spec (exact version, dist-tag, or semver range) and returns exactly the published bytes, with no overlay.",
        },
        {
          name: "If-None-Match",
          in: "header",
          required: false,
          description: "Entity-tag of a cached copy. A match yields `304 Not Modified`.",
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": {
          description: "File index",
          headers: {
            ...STD_RESPONSE_HEADERS,
            ETag: {
              description:
                'Strong entity-tag of this index representation (`"i-…"`), derived from the version artifact\'s integrity hash or from a content digest of the overlaid draft. It never matches a `files/content` tag.',
              schema: { type: "string" },
            },
            "Cache-Control": {
              description:
                "Always `private, no-cache`, for every selector — draft, exact version pin, dist-tag, semver range, yanked. Always `private`: the response is tenant-scoped. Never a fresh window and never `immutable`: this index is RBAC-gated, and a copy the browser may serve without contacting the server would outlive a revoked `<type>:read`, an org removal, or the package being uninstalled from the space. `no-cache` still permits the `304` round-trip, which a version pin answers from a single database read.",
              schema: { type: "string" },
            },
            Vary: {
              description:
                "Always `X-Org-Id, X-Space-Id` — access depends on both, so a cache must not reuse this body across organizations or spaces.",
              schema: { type: "string" },
            },
            "X-Yanked": {
              description: "Present and set to `true` when the resolved version is yanked.",
              schema: { type: "string" },
            },
          },
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/PackageFileIndex" },
            },
          },
        },
        "304": {
          description: "Cached copy is still current (`If-None-Match` matched). No body.",
          headers: {
            ETag: {
              description: "Strong entity-tag of this index representation.",
              schema: { type: "string" },
            },
            "Cache-Control": {
              description: "Always `private, no-cache`, as on the `200`.",
              schema: { type: "string" },
            },
            Vary: {
              description: "Always `X-Org-Id, X-Space-Id`, as on the `200`.",
              schema: { type: "string" },
            },
            "X-Yanked": {
              description: "Present and set to `true` when the resolved version is yanked.",
              schema: { type: "string" },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "422": { $ref: "#/components/responses/PackageArchiveUnreadable" },
        "429": { $ref: "#/components/responses/RateLimited" },
        "500": {
          description:
            "The artifact could not be read: integrity/signature verification failed (`INTEGRITY_MISMATCH`), or the stored bytes are not a readable ZIP. RFC 9457 problem+json.",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
      },
    },
  },
  "/api/packages/{scope}/{name}/files/content": {
    get: {
      operationId: "getPackageFileContent",
      tags: ["Packages"],
      summary: "Download one file from a package artifact",
      description:
        "Raw bytes of a single file from the package artifact — the fetch path for both preview and " +
        "download. Always served as `application/octet-stream` with `nosniff` and `attachment`: package " +
        "bytes are author-controlled and must never be rendered or executed in the platform origin. " +
        "`path` must match an entry returned by `GET /api/packages/{scope}/{name}/files` exactly; " +
        "anything else is a `404`. Read-only. Rate-limited to 50 requests/minute.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
        {
          name: "path",
          in: "query",
          required: true,
          schema: { type: "string" },
          description: "Exact `path` of an entry from the file index.",
        },
        {
          name: "version",
          in: "query",
          required: false,
          schema: { type: "string" },
          description:
            "Which snapshot to read from — same resolution as the file index: omitted (or `draft`) reads the live draft with the database overlay, any other value is an exact version, dist-tag, or semver range.",
        },
        {
          name: "If-None-Match",
          in: "header",
          required: false,
          description: "Entity-tag of a cached copy. A match yields `304 Not Modified`.",
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": {
          description: "Raw file bytes",
          headers: {
            ...STD_RESPONSE_HEADERS,
            ETag: {
              description:
                'Strong entity-tag of THIS FILE (`"f-…"`), folding in both the snapshot identity and the `path`. Per RFC 9110 §8.8.1 it identifies one representation: a tag obtained for another `path`, or from the file index, will not match.',
              schema: { type: "string" },
            },
            "Cache-Control": {
              description:
                "Always `private, no-cache`, for every selector — draft, exact version pin, dist-tag, semver range, yanked. Never a fresh window and never `immutable`: these bytes are RBAC-gated, and a copy the browser may serve without contacting the server would outlive a revoked `<type>:read`, an org removal, or the package being uninstalled from the space.",
              schema: { type: "string" },
            },
            Vary: {
              description:
                "Always `X-Org-Id, X-Space-Id` — access depends on both, so a cache must not reuse these bytes across organizations or spaces.",
              schema: { type: "string" },
            },
            "X-Yanked": {
              description: "Present and set to `true` when the resolved version is yanked.",
              schema: { type: "string" },
            },
            "Content-Disposition": {
              description: "`attachment` with the file's sanitized base name.",
              schema: { type: "string" },
            },
            "X-Content-Type-Options": {
              description: "Always `nosniff`.",
              schema: { type: "string" },
            },
            "Referrer-Policy": {
              description: "Always `no-referrer`.",
              schema: { type: "string" },
            },
            "Cross-Origin-Resource-Policy": {
              description: "Always `same-origin`.",
              schema: { type: "string" },
            },
          },
          content: {
            "application/octet-stream": {
              schema: { type: "string", format: "binary" },
            },
          },
        },
        "304": {
          description:
            "Cached copy of THIS file is still current (`If-None-Match` matched its per-file tag). No body. A bare `If-None-Match: *` is deliberately NOT honoured before the artifact is read — it carries no path, so it cannot establish that the file exists.",
          headers: {
            ETag: {
              description: "Strong entity-tag of this file representation.",
              schema: { type: "string" },
            },
            "Cache-Control": {
              description: "Always `private, no-cache`, as on the `200`.",
              schema: { type: "string" },
            },
            Vary: {
              description: "Always `X-Org-Id, X-Space-Id`, as on the `200`.",
              schema: { type: "string" },
            },
            "X-Yanked": {
              description: "Present and set to `true` when the resolved version is yanked.",
              schema: { type: "string" },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "422": { $ref: "#/components/responses/PackageArchiveUnreadable" },
        "429": { $ref: "#/components/responses/RateLimited" },
        "500": {
          description:
            "The artifact could not be read: integrity/signature verification failed (`INTEGRITY_MISMATCH`), or the stored bytes are not a readable ZIP. RFC 9457 problem+json.",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
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
        { $ref: "#/components/parameters/XSpaceId" },
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
        "403": { $ref: "#/components/responses/Forbidden" },
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
      description:
        "List the skills available to the current space (`X-Space-Id`): " +
        listPackagesSharedDescription,
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        { $ref: "#/components/parameters/PackageActiveFilter" },
      ],
      responses: {
        "200": {
          description: "Skill list",
          headers: STD_RESPONSE_HEADERS,
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
                    home_space_id: "spc_3e6f8a1b-2c4d-4e70-8f92-a1b3c5d7e9f0",
                    home_writable: true,
                    home_shareable: true,
                    createdAt: "2026-01-10T08:00:00Z",
                    updatedAt: "2026-01-10T08:00:00Z",
                  },
                ],
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
    post: {
      operationId: "createSkill",
      tags: ["Packages"],
      summary: "Create a skill",
      description: "Create a new skill in the organization packages.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              // `content` is mandatory on create for every type whose content
              // file is (`agent`, `skill`) — the handler refuses a blank one.
              required: ["manifest", "content"],
              properties: {
                manifest: {
                  type: "object",
                  additionalProperties: true,
                  description:
                    "Skill package manifest (AFPS). The package ID is derived from `manifest.name`.",
                },
                content: {
                  type: "string",
                  description:
                    "SKILL.md content (markdown with YAML frontmatter). Must not be blank.",
                },
              },
              // An unknown field is a 400, never a silent drop: the create /
              // update bodies are `.strict()` in `routes/packages.ts`, so a
              // client still sending the retired `source_code` learns it is
              // gone instead of getting a 201 without it. Same rule the four
              // launch surfaces took in #1187.
              additionalProperties: false,
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Skill created",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: packageCreateResponseSchema("#/components/schemas/OrgPackageItemDetail"),
            },
          },
        },
        "400": {
          $ref: "#/components/responses/ValidationError",
          description:
            "Validation error. A SKILL.md violating AFPS §3.3 answers `validation_failed` with the offending rule as the first `errors[]` entry's `code`: `skill_invalid_frontmatter`, `skill_missing_frontmatter_name`, `skill_invalid_frontmatter_name`, `skill_missing_frontmatter_description` or `skill_invalid_frontmatter_description`.",
        },
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
        { $ref: "#/components/parameters/XSpaceId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
      ],
      responses: {
        "200": {
          description: "Version info",
          headers: STD_RESPONSE_HEADERS,
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
        "403": { $ref: "#/components/responses/Forbidden" },
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
        { $ref: "#/components/parameters/XSpaceId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
      ],
      responses: {
        "200": {
          description: "Version list",
          headers: STD_RESPONSE_HEADERS,
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
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    post: {
      operationId: "createSkillVersion",
      tags: ["Packages"],
      summary: "Create a version from draft",
      description:
        "Create an immutable version snapshot from the current skill draft. Version is determined by the manifest version field unless overridden." +
        PACKAGE_MUTATION_AUTHORITY,
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
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
                  minLength: 1,
                  description: "Optional semver version override (e.g. from bump selector)",
                },
              },
              additionalProperties: false,
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Version created",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: versionCreateResponseSchema(),
            },
          },
        },
        "400": {
          $ref: "#/components/responses/ValidationError",
          description:
            "Validation error. A SKILL.md violating AFPS §3.3 answers `validation_failed` with the offending rule as the first `errors[]` entry's `code`: `skill_invalid_frontmatter`, `skill_missing_frontmatter_name`, `skill_invalid_frontmatter_name`, `skill_missing_frontmatter_description` or `skill_invalid_frontmatter_description`.",
        },
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
        "Restore a previously published version into the skill draft. Does not create a new version." +
        PACKAGE_MUTATION_AUTHORITY,
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
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
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: versionRestoreResponseSchema("#/components/schemas/OrgPackageItemDetail"),
            },
          },
        },
        "400": {
          $ref: "#/components/responses/ValidationError",
          description:
            "Validation error. A SKILL.md violating AFPS §3.3 answers `validation_failed` with the offending rule as the first `errors[]` entry's `code`: `skill_invalid_frontmatter`, `skill_missing_frontmatter_name`, `skill_invalid_frontmatter_name`, `skill_missing_frontmatter_description` or `skill_invalid_frontmatter_description`.",
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
        { $ref: "#/components/parameters/XSpaceId" },
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
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/PackageVersionDetail" },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    delete: {
      operationId: "deleteSkillVersion",
      tags: ["Packages"],
      summary: "Delete a skill version",
      description:
        "Permanently delete a skill version. Reassigns affected dist-tags to the next best stable version." +
        PACKAGE_MUTATION_AUTHORITY,
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
        { name: "version", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "204": {
          description: "Version deleted",
          headers: REQUEST_ID_ONLY_HEADERS,
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
        { $ref: "#/components/parameters/XSpaceId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
      ],
      responses: {
        "200": {
          description: "Skill detail",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/OrgPackageItemDetail" },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    put: {
      operationId: "updateSkill",
      tags: ["Packages"],
      summary: "Update a skill",
      description:
        "Update a skill in the organization packages. Built-in skills cannot be modified." +
        PACKAGE_MUTATION_AUTHORITY,
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["lock_version"],
              properties: {
                manifest: {
                  type: "object",
                  additionalProperties: true,
                  description: "Package manifest",
                },
                content: { type: "string" },
                lock_version: { type: "integer", description: "Optimistic lock version" },
              },
              additionalProperties: false,
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Skill updated",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: packageUpdateResponseSchema("#/components/schemas/OrgPackageItemDetail"),
            },
          },
        },
        "400": {
          $ref: "#/components/responses/ValidationError",
          description:
            "Validation error. A SKILL.md violating AFPS §3.3 answers `validation_failed` with the offending rule as the first `errors[]` entry's `code`: `skill_invalid_frontmatter`, `skill_missing_frontmatter_name`, `skill_invalid_frontmatter_name`, `skill_missing_frontmatter_description` or `skill_invalid_frontmatter_description`.",
        },
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
        "Delete a skill from the organization packages. Built-in skills cannot be deleted." +
        PACKAGE_MUTATION_AUTHORITY,
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
      ],
      responses: {
        "204": {
          description: "Skill deleted",
          headers: REQUEST_ID_ONLY_HEADERS,
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
      description:
        "List the agent packages available to the current space (`X-Space-Id`): " +
        listPackagesSharedDescription,
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        { $ref: "#/components/parameters/PackageActiveFilter" },
      ],
      responses: {
        "200": {
          description: "Agent list",
          headers: STD_RESPONSE_HEADERS,
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
        "403": { $ref: "#/components/responses/Forbidden" },
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
        { $ref: "#/components/parameters/XSpaceId" },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              // `content` is mandatory on create for every type whose content
              // file is (`agent`, `skill`) — the handler refuses a blank one.
              required: ["manifest", "content"],
              properties: {
                manifest: { $ref: "#/components/schemas/AgentManifest" },
                content: {
                  type: "string",
                  description: "Agent prompt (markdown). Must not be blank.",
                },
              },
              additionalProperties: false,
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Agent created",
          headers: STD_RESPONSE_HEADERS,
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
      description:
        "Returns agent detail including `input`, `output`, and the `dependencies` group (skills, mcp_servers, integrations). Two tiers of read: `agents:read` returns the whole resource, while `agents:run` alone returns a summary — `input` (schema, stored values, locked fields), `output`, `effective_timeout_seconds`, `home_space_id`, `home_writable`, `running_runs`, `last_run` and `dependencies.integrations` — omitting `manifest`, `prompt`, `updatedAt`, `lock_version`, `version_count`, `has_unarchived_changes`, `forked_from` and the skills and MCP servers the agent is built from (`dependencies.skills`, `dependencies.mcp_servers`).",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
        {
          name: "version",
          in: "query",
          required: false,
          schema: { type: "string" },
          description:
            "Which agent definition to project: `draft` (the live editor working copy), `published` (latest published), or a version spec (exact version, dist-tag, or semver range). **Omitting resolves the `draft`** (the editor default). A concrete version returns `input` / `output` / `dependencies` from that published manifest — the same definition the run executes (issue #770) — so the run-with-options modal stays consistent with the selected version. Ignored for system agents.",
        },
      ],
      responses: {
        "200": {
          description: "Agent detail",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/AgentDetail" },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    put: {
      operationId: "updateAgent",
      tags: ["Packages"],
      summary: "Update a user agent",
      description:
        "Update manifest and content of a user agent with optimistic locking." +
        PACKAGE_MUTATION_AUTHORITY,
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["lock_version"],
              properties: {
                manifest: { $ref: "#/components/schemas/AgentManifest" },
                content: { type: "string" },
                lock_version: { type: "integer", description: "Optimistic lock version" },
              },
              additionalProperties: false,
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Agent updated",
          headers: STD_RESPONSE_HEADERS,
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
      description:
        "Delete a user agent. Built-in agents cannot be deleted." + PACKAGE_MUTATION_AUTHORITY,
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
      ],
      responses: {
        "204": {
          description: "Agent deleted",
          headers: REQUEST_ID_ONLY_HEADERS,
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
        { $ref: "#/components/parameters/XSpaceId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
      ],
      responses: {
        "200": {
          description: "Version info",
          headers: STD_RESPONSE_HEADERS,
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
        "403": { $ref: "#/components/responses/Forbidden" },
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
        { $ref: "#/components/parameters/XSpaceId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
      ],
      responses: {
        "200": {
          description: "Version list",
          headers: STD_RESPONSE_HEADERS,
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
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    post: {
      operationId: "createAgentVersion",
      tags: ["Packages"],
      summary: "Create an agent version from draft",
      description:
        "Create an immutable version snapshot. Version is determined by the manifest version field unless overridden. Requires no running runs." +
        PACKAGE_MUTATION_AUTHORITY,
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
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
                  minLength: 1,
                  description: "Optional semver version override (e.g. from bump selector)",
                },
              },
              additionalProperties: false,
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Version created",
          headers: STD_RESPONSE_HEADERS,
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
      description:
        "Restore a published version into the draft. Requires no runs in progress." +
        PACKAGE_MUTATION_AUTHORITY,
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
        { name: "version", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "Version restored",
          headers: STD_RESPONSE_HEADERS,
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
        { $ref: "#/components/parameters/XSpaceId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
        { name: "version", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "Version detail",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/PackageVersionDetail" },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    delete: {
      operationId: "deleteAgentVersion",
      tags: ["Packages"],
      summary: "Delete an agent version",
      description:
        "Permanently delete an agent version. Reassigns affected dist-tags to the next best stable version. Blocked if runs are in progress." +
        PACKAGE_MUTATION_AUTHORITY,
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
        { name: "version", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "204": {
          description: "Version deleted",
          headers: REQUEST_ID_ONLY_HEADERS,
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
  "/api/packages/{scope}/{name}": {
    patch: {
      operationId: "movePackageHome",
      tags: ["Packages"],
      summary: "Move a package to another home space",
      description:
        "Change the package's home space — the space whose `<type>:write` authorizes editing, publishing, renaming and deleting it. The caller must hold that permission in BOTH the current home (or be an organization owner/admin in session when the package has none) and the destination space, which must be one the caller can reach; an unreachable destination answers 404 rather than confirming it exists. Passing `null` hands the package to the organization catalog, which only owners and admins may then write — reserved to them for that reason. This route touches nothing else: the draft is edited through `PUT /api/packages/{type}/{scope}/{name}`, under its optimistic lock.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["home_space_id"],
              properties: {
                home_space_id: {
                  type: ["string", "null"],
                  description:
                    "Destination space id (`spc_…`), or `null` for the organization catalog.",
                },
              },
              additionalProperties: false,
            },
          },
        },
      },
      responses: {
        "200": {
          description: "The package resource, with its new `home_space_id`.",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: {
                oneOf: [
                  { $ref: "#/components/schemas/AgentDetail" },
                  { $ref: "#/components/schemas/OrgPackageItemDetail" },
                ],
                description:
                  "The moved package resource — same shape as its GET detail (`AgentDetail` for agents, otherwise `OrgPackageItemDetail`). No follow-up GET needed.",
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
  "/api/packages/{scope}/{name}/shares": {
    get: {
      operationId: "listPackageShares",
      tags: ["Packages"],
      summary: "List the spaces a package is shared with",
      description:
        "The package's AUDIENCE — the spaces it is offered to. Requires the package type's `share` permission in its home space (organization owner or admin when the package has none); a package the caller cannot reach at all answers 404. A personal-space target is rendered as its OWNER, never as a space id.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
      ],
      responses: {
        "200": {
          description: "The package's shares, oldest first.",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["object", "data", "hasMore"],
                properties: {
                  object: { type: "string", enum: ["list"] },
                  data: {
                    type: "array",
                    items: { $ref: "#/components/schemas/PackageShare" },
                  },
                  hasMore: {
                    type: "boolean",
                    description: "Always false — a package's audience is not paginated.",
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
    post: {
      operationId: "sharePackage",
      tags: ["Packages"],
      summary: "Share a package with a person or a space",
      description:
        "Offer the package to a space — its AUDIENCE, never its installation, which stays the recipient's own act (`POST …/shares/accept`). Requires the package type's `share` permission in the package's home space (organization owner or admin when it has none); `share` is carried by the `admin` and `builder` presets and by no API key. A `user` target additionally requires `members:read` and is resolved server-side to that member's personal space, created if they have none — the sharer never learns its id. A `space` target must be a space the caller can reach, so another member's personal space is not targetable by id (404). Sharing a package with the space it already lives in is `409 share_target_is_home`. Idempotent: sharing the same pair twice answers 200 with the same entry.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["target"],
              properties: { target: { $ref: "#/components/schemas/ShareTarget" } },
              additionalProperties: false,
            },
          },
        },
      },
      responses: {
        "200": {
          description: "The share, new or already present.",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/PackageShare" },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": {
          description:
            "The target space is the package's own home (`share_target_is_home`). RFC 9457 problem+json.",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
      },
    },
  },
  "/api/packages/{scope}/{name}/shares/accept": {
    post: {
      operationId: "acceptPackageShare",
      tags: ["Packages"],
      summary: "Add a shared package to your own space",
      description:
        "Install a package that was shared with you into your OWN personal space, pinned to the `latest` published version. Deliberately requires neither the `share` permission nor the package type's install grant: the space's owner consented by calling this, and a `guest` holds only the `operator` preset in their own space. The package must have a share row for that space, otherwise 404 — an offer the caller never received is indistinguishable from a package that does not exist. Idempotent in the useful direction: calling it again RE-PINS the installation to `latest`, which is how the owner takes a version the author has since published. API keys, end-users and role previews have no personal space and answer 404.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
      ],
      responses: {
        "200": {
          description: "Installed (or re-pinned) in the caller's personal space.",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["object", "package_id", "version_id"],
                properties: {
                  object: { type: "string", enum: ["space_package"] },
                  package_id: { type: "string" },
                  version_id: {
                    type: "integer",
                    description: "The pinned version's id — the `latest` dist-tag at accept time.",
                  },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": {
          description:
            "The package has no published version to pin (`package_has_no_version`). A shared package is always installed at a pin, so there is nothing to install until its author publishes. RFC 9457 problem+json.",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
        "422": { $ref: "#/components/responses/PackageArchiveUnreadable" },
      },
    },
  },
  "/api/packages/{scope}/{name}/shares/{target}": {
    delete: {
      operationId: "revokePackageShare",
      tags: ["Packages"],
      summary: "Withdraw a package share",
      description:
        "Remove the offer AND the installation it backs, in one transaction: a package left running in a space that may no longer see it is the failure the two-table split exists to prevent. Same authority as sharing — the package type's `share` in its home space. 404 when the package is not shared with that target.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
        {
          name: "target",
          in: "path",
          required: true,
          schema: { type: "string" },
          description:
            "The share's target exactly as `GET …/shares` published it: a space id (`spc_…`) for a `space` target, or the member's user id for a `user` target. The two are told apart by the space-id shape. There is no third spelling: the id of another member's personal space is never on the wire, so it cannot be the handle here.",
        },
      ],
      responses: {
        "204": { description: "Share (and any installation behind it) removed." },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/packages/{scope}/{name}/fork": {
    post: {
      operationId: "forkPackage",
      tags: ["Packages"],
      summary: "Fork a package to your organization",
      description:
        "Create a copy of a package the org does not already own (e.g. a read-only system package) under the current organization's scope. Org-owned packages are editable in place regardless of their scope name, so forking is only needed for packages the org does not own. Reading a source in another organization requires a session caller with live membership and package read access in that source organization; space-pinned credentials cannot cross organizations. Published versions alone do not grant visibility. The caller also needs the source package type's write permission in the destination space. The fork is based on the latest published version of the source package — the version manifest, content, and ZIP are copied. A local published version is automatically created. Returns 400 if the source has no published version.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
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
              additionalProperties: false,
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Package forked successfully",
          headers: STD_RESPONSE_HEADERS,
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
        // Same CONDITION as `#/components/responses/PackageArchiveUnreadable`,
        // deliberately NOT `$ref`-ed: the shared component tells the caller to
        // republish the package, which is impossible here (a fork's source is
        // always a package the calling org does not own), and it cannot state
        // that nothing was written. Both facts are specific to this boundary.
        "422": {
          description:
            "The SOURCE package's published artifact expands past the platform's decompression ceiling and was refused (`package_archive_unreadable`). Nothing was written: the fork is rejected while reading the source, before the name-collision check and before any package or version row is created, so there is no partial copy to clean up. A fork always targets a package the calling organization does NOT own, so the caller cannot repair the source — report it to whoever publishes it (or to the platform operator if it is a system package). RFC 9457 problem+json.",
          headers: REQUEST_ID_ONLY_HEADERS,
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
      },
    },
  },
  // --- By-ID routes (unscoped package identifiers) ---

  // --- Integration package CRUD routes (registry packages, distinct from the
  //     /api/integrations connection domain) ---

  "/api/packages/integrations": {
    get: {
      operationId: "listIntegrationPackages",
      tags: ["Packages"],
      summary: "List integration packages",
      description:
        "List the integration packages available to the current space " +
        "(`X-Space-Id`): " +
        listPackagesSharedDescription,
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        { $ref: "#/components/parameters/PackageActiveFilter" },
      ],
      responses: {
        "200": {
          description: "Integration package list",
          headers: STD_RESPONSE_HEADERS,
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
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
    post: {
      operationId: "createIntegrationPackage",
      tags: ["Packages"],
      summary: "Create an integration package, including a remote MCP",
      description:
        'Create a new integration package in the organization packages. An upstream-hosted MCP endpoint belongs here as an integration with `source.kind: "remote"`; use an MCP-server package only for a local executable referenced by `source.kind: "local"`.',
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
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
                  description: "Primary package file content (manifest file).",
                },
              },
              additionalProperties: false,
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Integration package created",
          headers: STD_RESPONSE_HEADERS,
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
        { $ref: "#/components/parameters/XSpaceId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
      ],
      responses: {
        "200": {
          description: "Version info",
          headers: STD_RESPONSE_HEADERS,
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
        "403": { $ref: "#/components/responses/Forbidden" },
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
        { $ref: "#/components/parameters/XSpaceId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
      ],
      responses: {
        "200": {
          description: "Version list",
          headers: STD_RESPONSE_HEADERS,
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
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    post: {
      operationId: "createIntegrationPackageVersion",
      tags: ["Packages"],
      summary: "Create a version from draft",
      description:
        "Create an immutable version snapshot from the current integration package draft. Version is determined by the manifest version field unless overridden." +
        PACKAGE_MUTATION_AUTHORITY,
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
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
                  minLength: 1,
                  description: "Optional semver version override (e.g. from bump selector)",
                },
              },
              additionalProperties: false,
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Version created",
          headers: STD_RESPONSE_HEADERS,
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
        "Restore a previously published version into the integration package draft. Does not create a new version." +
        PACKAGE_MUTATION_AUTHORITY,
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
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
          headers: STD_RESPONSE_HEADERS,
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
        { $ref: "#/components/parameters/XSpaceId" },
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
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/PackageVersionDetail" },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    delete: {
      operationId: "deleteIntegrationPackageVersion",
      tags: ["Packages"],
      summary: "Delete an integration package version",
      description:
        "Permanently delete an integration package version. Reassigns affected dist-tags to the next best stable version." +
        PACKAGE_MUTATION_AUTHORITY,
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
        { name: "version", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "204": {
          description: "Version deleted",
          headers: REQUEST_ID_ONLY_HEADERS,
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
        { $ref: "#/components/parameters/XSpaceId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
      ],
      responses: {
        "200": {
          description: "Integration package detail",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/OrgPackageItemDetail" },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    put: {
      operationId: "updateIntegrationPackage",
      tags: ["Packages"],
      summary: "Update an integration package",
      description:
        "Update an integration package in the organization packages. Built-in integration packages cannot be modified." +
        PACKAGE_MUTATION_AUTHORITY,
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["lock_version"],
              properties: {
                manifest: {
                  type: "object",
                  additionalProperties: true,
                  description: "Package manifest",
                },
                content: { type: "string" },
                lock_version: { type: "integer", description: "Optimistic lock version" },
              },
              additionalProperties: false,
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Integration package updated",
          headers: STD_RESPONSE_HEADERS,
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
        "Delete an integration package from the organization packages. Built-in integration packages cannot be deleted." +
        PACKAGE_MUTATION_AUTHORITY,
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
      ],
      responses: {
        "204": {
          description: "Integration package deleted",
          headers: REQUEST_ID_ONLY_HEADERS,
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
      description:
        "List the MCP-server packages available to the current space " +
        "(`X-Space-Id`): " +
        listPackagesSharedDescription,
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        { $ref: "#/components/parameters/PackageActiveFilter" },
      ],
      responses: {
        "200": {
          description: "MCP-server package list",
          headers: STD_RESPONSE_HEADERS,
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
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
    post: {
      operationId: "createMcpServerPackage",
      tags: ["Packages"],
      summary: "Create a local MCP-server executable package",
      description:
        'Create a local executable MCP-server package referenced by an integration with `source.kind: "local"`. For an upstream-hosted MCP endpoint, create an integration package with `source.kind: "remote"` instead.',
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
      ],
      requestBody: {
        required: true,
        description:
          "Upload a self-contained package archive (`multipart/form-data` with a `.afps`/`.zip` file). The package ID is derived from the file name. The archive must contain a valid `manifest.json` and the file referenced by `server.entry_point`; JSON manifest-only creation is refused with `415 archive_required`.",
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
                    "Package archive (`.afps` or `.zip`) containing a valid `manifest.json`. File name (sans extension) is the kebab-case package id.",
                },
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "MCP-server package created",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: packageCreateResponseSchema("#/components/schemas/OrgPackageItemDetail"),
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "415": { $ref: "#/components/responses/UnsupportedMediaType" },
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
        { $ref: "#/components/parameters/XSpaceId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
      ],
      responses: {
        "200": {
          description: "Version info",
          headers: STD_RESPONSE_HEADERS,
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
        "403": { $ref: "#/components/responses/Forbidden" },
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
        { $ref: "#/components/parameters/XSpaceId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
      ],
      responses: {
        "200": {
          description: "Version list",
          headers: STD_RESPONSE_HEADERS,
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
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    post: {
      operationId: "createMcpServerPackageVersion",
      tags: ["Packages"],
      summary: "Create a version from draft",
      description:
        "Create an immutable version snapshot from the current MCP-server package draft. Version is determined by the manifest version field unless overridden." +
        PACKAGE_MUTATION_AUTHORITY,
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
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
                  minLength: 1,
                  description: "Optional semver version override (e.g. from bump selector)",
                },
              },
              additionalProperties: false,
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Version created",
          headers: STD_RESPONSE_HEADERS,
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
        "Restore a previously published version into the MCP-server package draft. Does not create a new version." +
        PACKAGE_MUTATION_AUTHORITY,
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
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
          headers: STD_RESPONSE_HEADERS,
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
        { $ref: "#/components/parameters/XSpaceId" },
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
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/PackageVersionDetail" },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    delete: {
      operationId: "deleteMcpServerPackageVersion",
      tags: ["Packages"],
      summary: "Delete an MCP-server package version",
      description:
        "Permanently delete an MCP-server package version. Reassigns affected dist-tags to the next best stable version." +
        PACKAGE_MUTATION_AUTHORITY,
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
        { name: "version", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "204": {
          description: "Version deleted",
          headers: REQUEST_ID_ONLY_HEADERS,
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
        { $ref: "#/components/parameters/XSpaceId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
      ],
      responses: {
        "200": {
          description: "MCP-server package detail",
          headers: STD_RESPONSE_HEADERS,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/OrgPackageItemDetail" },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    put: {
      operationId: "updateMcpServerPackage",
      tags: ["Packages"],
      summary: "Update an MCP-server package",
      description:
        "Update an MCP-server package in the organization packages. Built-in MCP-server packages cannot be modified." +
        PACKAGE_MUTATION_AUTHORITY,
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["lock_version"],
              properties: {
                manifest: {
                  type: "object",
                  additionalProperties: true,
                  description: "Package manifest",
                },
                content: { type: "string" },
                lock_version: { type: "integer", description: "Optimistic lock version" },
              },
              additionalProperties: false,
            },
          },
        },
      },
      responses: {
        "200": {
          description: "MCP-server package updated",
          headers: STD_RESPONSE_HEADERS,
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
        "Delete an MCP-server package from the organization packages. Built-in MCP-server packages cannot be deleted." +
        PACKAGE_MUTATION_AUTHORITY,
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        { $ref: "#/components/parameters/PackageScope" },
        { $ref: "#/components/parameters/PackageName" },
      ],
      responses: {
        "204": {
          description: "MCP-server package deleted",
          headers: REQUEST_ID_ONLY_HEADERS,
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
