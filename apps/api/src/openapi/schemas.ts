// SPDX-License-Identifier: Apache-2.0

import { orgRoleEnum } from "@appstrate/db/schema";

const ORG_ROLES = [...orgRoleEnum.enumValues];

/**
 * All OpenAPI schema definitions (components/schemas).
 */
export const schemas = {
  // Shared field-error item carrying the connection-resolution "smuggle"
  // fields surfaced by services/integration-connection-resolver.ts:
  // translateResolutionError (mirrors the `ResolutionFieldError` TS type in
  // @appstrate/core/api-errors). Extracted into one component so every
  // consumer (ProblemDetail.errors, and any future readiness DTO) shares one
  // shape and can't drift. The base four (`field`/`code`/`message`/`title`)
  // come from ValidationFieldError; the six snake_case extras are each
  // populated only for the matching resolution `code` and so are all optional.
  ResolutionFieldError: {
    type: "object",
    required: ["field", "code", "message"],
    properties: {
      field: { type: "string" },
      code: { type: "string" },
      message: { type: "string" },
      title: {
        type: "string",
        description: "Human-readable title; preserved from the underlying error factory.",
      },
      // Channel-specific smuggles surfaced by services/integration-connection-resolver.ts:translateResolutionError.
      // Documented here so SDK consumers can rely on them without reading the resolver source.
      candidate_connection_ids: {
        type: "array",
        items: { type: "string" },
        description:
          "Populated on `must_choose_connection`. Connection ids the caller may pick from; pass one back via the request body's `connection_overrides` map to retry the run.",
      },
      connection_id: {
        type: "string",
        description:
          "Populated on `needs_reconnection` and `insufficient_scopes`. Forward as `connectionId` on the OAuth re-kickoff so the callback UPDATEs the existing row in place (avoids duplicate INSERT — single-writer contract in `integration-connections.ts:persistCredentialBundle`).",
      },
      missing_scopes: {
        type: "array",
        items: { type: "string" },
        description:
          "Populated on `insufficient_scopes`. OAuth scopes the agent's selected tools require that the connection lacks; forwarded to the OAuth re-consent prompt.",
      },
      owned_by_actor: {
        type: "boolean",
        description:
          "Populated on `insufficient_scopes`. True when the under-scoped connection belongs to the calling actor (UI offers an upgrade) vs. a foreign shared row (read-only error).",
      },
      required_auth_key: {
        type: "string",
        description:
          "Populated on `auth_key_mismatch`. The agent dep's pinned `auth_key` per AFPS §4.1.",
      },
      available_auth_keys: {
        type: "array",
        items: { type: "string" },
        description:
          "Populated on `auth_key_mismatch`. Auth keys the actor's existing connections use; helps the UI route to the correct connect method.",
      },
    },
  },
  ProblemDetail: {
    type: "object",
    description: "RFC 9457 Problem Details for HTTP APIs",
    required: ["type", "title", "status", "detail", "code", "requestId"],
    properties: {
      type: { type: "string", format: "uri", description: "URI reference to error documentation" },
      title: { type: "string", description: "Short summary of the error type" },
      status: { type: "integer", description: "HTTP status code" },
      detail: { type: "string", description: "Human-readable explanation of this occurrence" },
      instance: {
        type: "string",
        description: "URI reference identifying this specific occurrence",
      },
      code: { type: "string", description: "Machine-readable error code (snake_case)" },
      requestId: { type: "string", description: "Unique request identifier (req_ prefix)" },
      param: { type: "string", description: "Parameter that caused the error" },
      retryAfter: { type: "integer", description: "Seconds before retry (on 429)" },
      errors: {
        type: "array",
        description: "Field-level validation errors",
        items: { $ref: "#/components/schemas/ResolutionFieldError" },
      },
    },
  },
  User: {
    type: "object",
    // Better-Auth-owned shape: the platform documents the three fields it
    // relies on, but Better Auth also emits emailVerified/image/createdAt/
    // updatedAt (+ the platform `realm` column). The SPA reads the user via the
    // Better Auth client, not the generated OpenAPI type, so the full set is
    // framework-owned — declare the response open rather than mirror an
    // upstream shape that changes on Better Auth upgrades.
    additionalProperties: true,
    required: ["id", "name", "email"],
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      email: { type: "string" },
    },
  },
  ApplicationPackage: {
    type: "object",
    description: "A package installed in an application with its config and overrides.",
    // The installedPackageSelect projection emits every field unconditionally
    // (config is the raw JSONB column; package_type/package_source come from
    // the join). `object` is spec-only (not on the InstalledPackage type).
    //
    // CASING: this object deliberately mixes cases and the spec matches the
    // runtime serializer (`services/application-packages.ts:installedPackageSelect`)
    // field-for-field — spec==runtime is the hard invariant, so do NOT "normalize".
    //   - `packageId`/`modelId`/`proxyId`/`updatedAt` are camelCase per the
    //     universal *Id / timestamp carve-out (docs/CASING_CONVENTIONS.md).
    //   - `version_id`/`installed_at` are snake_case: the projection aliases them
    //     that way, so they DIVERGE from the *Id / timestamp carve-out. Documented
    //     module carve-out — the write path (`updatePackageSchema`,
    //     `PUT .../packages/{scope}/{name}` body) uses the same `version_id` key,
    //     so read and write stay symmetric. A client that sends `versionId`
    //     (camel, per the carve-out expectation) has its version pin silently
    //     dropped by the Zod body schema — the divergence is load-bearing and
    //     intentional here, not an accident.
    required: [
      "packageId",
      "config",
      "modelId",
      "proxyId",
      "version_id",
      "enabled",
      "installed_at",
      "updatedAt",
      "package_type",
      "package_source",
      "draft_manifest",
    ],
    properties: {
      object: { type: "string", enum: ["application_package"] },
      packageId: { type: "string", description: "Package ID from org catalog" },
      config: { type: "object", description: "Application-specific configuration" },
      modelId: { type: ["string", "null"], description: "Model override for this app" },
      proxyId: { type: ["string", "null"], description: "Proxy override for this app" },
      version_id: { type: ["integer", "null"], description: "Pinned version (null = latest)" },
      enabled: { type: "boolean" },
      installed_at: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
      package_type: { type: "string", enum: ["agent", "skill", "mcp-server", "integration"] },
      package_source: { type: "string", enum: ["system", "local"] },
      draft_manifest: {
        type: ["object", "null"],
        description: "Raw draft manifest JSONB for the installed package.",
      },
    },
  },
  OrgSettings: {
    type: "object",
    description: "Organization settings (extensible)",
    properties: {
      api_version: {
        type: "string",
        description:
          "Pinned API version for this organization (format: YYYY-MM-DD). Automatically set to the current version at org creation. New API versions do not affect existing orgs until explicitly updated.",
      },
      dashboard_sso_enabled: {
        type: "boolean",
        description:
          "When true, org-level (dashboard) OAuth clients can be created and the SSO tab is exposed in the org settings UI. Defaults to false — most orgs only need application-level SSO for their end-users.",
      },
    },
  },
  ProfileBatchItem: {
    type: "object",
    required: ["id"],
    properties: {
      id: { type: "string" },
      // Nullable: `profiles.display_name` has no NOT NULL constraint, so a
      // member who never set a display name serializes `null` here. Mirrors
      // the sibling `UserProfile.displayName`.
      displayName: { type: ["string", "null"] },
    },
  },
  UserProfile: {
    type: "object",
    description:
      "The dashboard user's profile — single serializer shared by GET and PATCH /api/profile.",
    required: ["id", "language", "email", "name"],
    properties: {
      id: { type: "string" },
      displayName: { type: ["string", "null"] },
      language: { type: "string", enum: ["fr", "en"] },
      email: { type: "string", format: "email" },
      name: { type: "string" },
    },
  },
  Organization: {
    type: "object",
    required: ["id", "name", "slug", "role", "createdAt"],
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      slug: { type: "string" },
      role: { type: "string", enum: ORG_ROLES },
      createdAt: { type: "string", format: "date-time", description: "Creation timestamp" },
    },
  },
  OrgMember: {
    type: "object",
    // `email`/`displayName` are best-effort joins (getOrgMembers emits
    // `?? undefined` when the user/profile row is missing) — NOT required.
    required: ["userId", "role", "joinedAt"],
    properties: {
      userId: { type: "string" },
      displayName: { type: "string" },
      email: { type: "string" },
      role: { type: "string", enum: ORG_ROLES },
      joinedAt: { type: "string", format: "date-time" },
    },
  },
  OrgInvitationInfo: {
    type: "object",
    required: ["id", "email", "role", "token", "expiresAt", "createdAt"],
    properties: {
      id: { type: "string" },
      email: { type: "string" },
      role: { type: "string", enum: ORG_ROLES },
      token: { type: "string" },
      expiresAt: { type: "string", format: "date-time" },
      createdAt: { type: "string", format: "date-time" },
    },
  },
  OrgDetail: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      slug: { type: "string" },
      createdAt: { type: "string", format: "date-time" },
      members: {
        type: "array",
        items: { $ref: "#/components/schemas/OrgMember" },
      },
      invitations: {
        type: "array",
        items: { $ref: "#/components/schemas/OrgInvitationInfo" },
      },
    },
  },
  AgentSkillRef: {
    type: "object",
    required: ["id"],
    properties: {
      id: { type: "string" },
      version: { type: "string" },
      name: { type: "string" },
      description: { type: "string" },
    },
  },
  AgentListItem: {
    type: "object",
    // `running_runs`/`dependencies`/`scope`/`keywords`/`version` are always
    // emitted by the GET /api/agents mapper. `display_name`/`description`/
    // `schema_version`/`author` stay optional (manifest-derived, may be absent);
    // `forked_from` is not emitted by the list endpoint (shared-type optional).
    required: [
      "id",
      "source",
      "type",
      "running_runs",
      "dependencies",
      "scope",
      "keywords",
      "version",
    ],
    properties: {
      id: { type: "string" },
      display_name: { type: "string" },
      description: { type: "string" },
      schema_version: { type: "string" },
      author: { type: "string" },
      keywords: { type: "array", items: { type: "string" } },
      source: { type: "string", enum: ["system", "local"] },
      scope: {
        type: ["string", "null"],
        description:
          "Scope from manifest name, including the leading `@` (e.g. `@myorg` from `@myorg/name`). Directly usable as the `{scope}` path parameter of package/agent operations.",
      },
      version: { type: ["string", "null"], description: "Version from manifest" },
      type: {
        type: "string",
        description: "Package type from manifest",
        enum: ["agent", "skill", "mcp-server", "integration"],
      },
      running_runs: { type: "integer" },
      dependencies: {
        type: "object",
        properties: {
          skills: { type: "object", additionalProperties: { type: "string" } },
          mcp_servers: { type: "object", additionalProperties: { type: "string" } },
          integrations: { type: "object", additionalProperties: { type: "string" } },
        },
      },
    },
  },
  AgentDetail: {
    type: "object",
    // Always emitted by buildAgentDetailDto. `display_name`/`description`/
    // `updatedAt`/`lock_version` stay optional: system agents omit the last two,
    // and the manifest-derived display_name/description may be absent (the
    // shared-type marks them optional to match).
    required: [
      "id",
      "source",
      "scope",
      "version",
      "dependencies",
      "config",
      "running_runs",
      "last_run",
      "forked_from",
    ],
    properties: {
      id: { type: "string" },
      display_name: { type: "string" },
      description: { type: "string" },
      source: { type: "string", enum: ["system", "local"] },
      scope: {
        type: ["string", "null"],
        description:
          "Scope from manifest name, including the leading `@` (e.g. `@myorg`). Directly usable as the `{scope}` path parameter of package/agent operations.",
      },
      version: { type: ["string", "null"], description: "Version from manifest" },
      manifest: {
        allOf: [{ $ref: "#/components/schemas/AgentManifest" }],
        description: "Full manifest object (user agents only)",
      },
      prompt: { type: "string", description: "Agent prompt markdown (user agents only)" },
      updatedAt: {
        type: "string",
        format: "date-time",
        description: "Last updated timestamp (user agents only)",
      },
      lock_version: {
        type: "integer",
        description: "Optimistic lock version (user agents only)",
      },
      config: {
        type: "object",
        // The detail serializer always emits `schema` (falls back to an empty
        // object schema when the manifest has no config wrapper).
        required: ["schema", "current"],
        description: "AFPS schema wrapper for agent configuration (set once, reused across runs).",
        properties: {
          schema: { type: "object", description: "Pure JSON Schema 2020-12 object" },
          current: { type: "object", description: "Current configuration values" },
          file_constraints: { $ref: "#/components/schemas/FileConstraintsMap" },
          ui_hints: { $ref: "#/components/schemas/UIHintsMap" },
          property_order: {
            type: "array",
            items: { type: "string" },
            description: "Presentation order for schema properties",
          },
        },
      },
      input: {
        type: "object",
        description: "AFPS schema wrapper for per-run input.",
        properties: {
          schema: { type: "object", description: "Pure JSON Schema 2020-12 object" },
          file_constraints: { $ref: "#/components/schemas/FileConstraintsMap" },
          ui_hints: { $ref: "#/components/schemas/UIHintsMap" },
          property_order: {
            type: "array",
            items: { type: "string" },
            description: "Presentation order for schema properties",
          },
        },
      },
      output: {
        type: "object",
        description: "AFPS schema wrapper for per-run output.",
        properties: {
          schema: { type: "object", description: "Pure JSON Schema 2020-12 object" },
          property_order: {
            type: "array",
            items: { type: "string" },
            description: "Presentation order for schema properties",
          },
        },
      },
      dependencies: {
        type: "object",
        // The detail serializer always emits all three arrays (skills/mcp_servers
        // from the manifest, integrations via parseManifestIntegrations).
        required: ["skills", "mcp_servers", "integrations"],
        properties: {
          skills: { type: "array", items: { $ref: "#/components/schemas/AgentSkillRef" } },
          mcp_servers: {
            type: "array",
            items: {
              type: "object",
              required: ["id", "version"],
              properties: {
                id: { type: "string" },
                version: { type: "string" },
              },
            },
            description: "AFPS §4.1 mcp_servers dependency group",
          },
          integrations: {
            type: "array",
            items: {
              type: "object",
              required: ["id", "version"],
              properties: {
                id: { type: "string" },
                version: { type: "string" },
                tools: {
                  oneOf: [
                    { type: "array", items: { type: "string" } },
                    { type: "string", enum: ["*"] },
                  ],
                  description:
                    "Niveau 2 tool allowlist (optional). Either an array of selected tool names or the AFPS §4.4 wildcard literal '*' opting the agent into every upstream tool (requires integration's `allow_undeclared_tools: true`).",
                },
                scopes: {
                  type: "array",
                  items: { type: "string" },
                  description: "Niveau 2 explicit scope escape hatch (optional)",
                },
              },
            },
          },
        },
      },
      last_run: {
        type: ["object", "null"],
        description: "Summary of the most recent run (null if never run)",
        // When present, the serializer always sets all four (id/status/started_at
        // are NOT NULL columns; duration is nullable but always emitted).
        required: ["id", "status", "started_at", "duration"],
        properties: {
          id: { type: "string" },
          status: { type: "string" },
          started_at: { type: "string", format: "date-time" },
          duration: { type: ["integer", "null"] },
        },
      },
      running_runs: { type: "integer" },
      version_count: {
        type: "integer",
        description: "Number of published versions (0 for built-in agents)",
      },
      forked_from: { type: ["string", "null"], description: "Source package ID if forked" },
      has_unarchived_changes: {
        type: "boolean",
        description: "Whether the active version has changes not yet archived as a version",
      },
    },
  },
  AgentVersion: {
    type: "object",
    required: ["id", "version", "integrity", "artifact_size", "yanked", "created_by", "createdAt"],
    properties: {
      id: { type: "integer" },
      packageId: { type: "string" },
      version: { type: "string", description: "Semver version string (e.g. 1.0.0)" },
      integrity: { type: "string", description: "SRI integrity hash (sha256-...)" },
      artifact_size: { type: "integer", description: "Artifact ZIP size in bytes" },
      yanked: { type: "boolean", description: "Whether this version has been yanked" },
      created_by: { type: ["string", "null"] },
      createdAt: { type: ["string", "null"], format: "date-time" },
    },
  },
  // Canonical version detail DTO — the exact shape the `GET .../versions/{version}`
  // endpoints serialize (the per-type GET detail uses a type-specific manifest
  // `$ref`; this generic form is reused by the version create/restore mutation
  // responses so they echo the resulting version resource — issue #646).
  PackageVersionDetail: {
    type: "object",
    required: [
      "id",
      "version",
      "manifest",
      "integrity",
      "artifact_size",
      "yanked",
      "yanked_reason",
      "createdAt",
      "dist_tags",
    ],
    properties: {
      id: { type: "integer", description: "Version row id" },
      version: { type: "string", description: "Semver version string (e.g. 1.0.0)" },
      manifest: {
        type: "object",
        additionalProperties: true,
        description: "Full version manifest (AFPS)",
      },
      content: {
        type: ["string", "null"],
        description: "Primary content file extracted from the version ZIP",
      },
      source_code: {
        type: ["string", "null"],
        description: "Secondary source file content (e.g. .ts), when present",
      },
      yanked: { type: "boolean", description: "Whether this version has been yanked" },
      yanked_reason: { type: ["string", "null"] },
      integrity: { type: "string", description: "SRI integrity hash (sha256-...)" },
      artifact_size: { type: "integer", description: "Artifact ZIP size in bytes" },
      createdAt: { type: ["string", "null"], format: "date-time" },
      dist_tags: { type: "array", items: { type: "string" } },
    },
  },
  Run: {
    type: "object",
    // Every field a run response carries unconditionally. The list/detail/
    // create handlers all route through `mapEnrichedRun` (services/state/runs.ts),
    // so the enriched join fields (`user_name`, `connections_used`, …) are as
    // guaranteed as the base columns. Only `inline_manifest` / `inline_prompt`
    // are detail-only (added by `getRunFull`) and stay optional. Keeping this
    // list exhaustive lets the SPA consume the generated `Run` type with no
    // cast and lets verify-openapi step 7 guard it against `EnrichedRun` drift.
    required: [
      "id",
      "packageId",
      "userId",
      "endUserId",
      "apiKeyId",
      "orgId",
      "applicationId",
      "scheduleId",
      "status",
      "input",
      "result",
      "checkpoint",
      "error",
      "metadata",
      "config",
      "config_override",
      "started_at",
      "completed_at",
      "duration",
      "cost",
      "runNumber",
      "token_usage",
      "version_label",
      "version_ref",
      "proxy_label",
      "model_label",
      "model_source",
      "runner_name",
      "runner_kind",
      "agent_scope",
      "agent_name",
      "runOrigin",
      "contextSnapshot",
      "modelCredentialId",
      "connection_overrides",
      "dependency_overrides",
      "user_name",
      "end_user_name",
      "api_key_name",
      "schedule_name",
      "connections_used",
      "package_ephemeral",
      "unread",
    ],
    properties: {
      id: { type: "string" },
      packageId: {
        type: ["string", "null"],
        description:
          "Source agent ID. NULL when the source agent has been deleted — the run row survives via `runs.package_id ON DELETE SET NULL` (migration 0017). Read `agent_scope` / `agent_name` for display in that case; re-running is not possible.",
      },
      userId: {
        type: ["string", "null"],
        description: "Dashboard user ID that triggered the run (null for end-user/schedule runs)",
      },
      orgId: { type: "string" },
      status: {
        type: "string",
        enum: ["pending", "running", "success", "failed", "timeout", "cancelled"],
      },
      // `runs.input` is a nullable jsonb column (createFailedRun writes null);
      // emitted verbatim, so the wire value can be null.
      input: { type: ["object", "null"], additionalProperties: true },
      result: {
        type: ["object", "null"],
        description:
          "What the run produced — the stable API contract for the run's deliverable, set when the run reaches a terminal status. `null` while the run is in flight, and on terminal runs that emitted neither structured output nor a report. Persisted even on failed runs (a run that reported and then failed keeps its partial deliverable).",
        properties: {
          output: {
            description:
              "Structured JSON emitted via the agent's `output` runtime tool. Validated against the agent's declared output schema when one exists — a schema mismatch flips the run to `failed` (with the validation errors in `error`) but the payload is still stored, never dropped.",
          },
          text: {
            type: "string",
            description:
              "Markdown report emitted via the agent's `report` runtime tool. Multiple report calls are concatenated in call order, joined with newlines. Capped at 256 KiB of UTF-8 — see `text_truncated`. The full untruncated report remains available as individual run-log entries (type='result', event='report').",
          },
          text_truncated: {
            type: "boolean",
            description:
              "Present and `true` when `text` exceeded the 256 KiB cap and was truncated at a UTF-8 character boundary. Absent otherwise.",
          },
        },
      },
      // `runs.checkpoint` is a nullable jsonb column — null on every run that
      // never emitted a checkpoint (pending/running/most terminal runs).
      checkpoint: { type: ["object", "null"], additionalProperties: true },
      error: { type: ["string", "null"] },
      token_usage: {
        type: ["object", "null"],
        description:
          "Snapshot of token consumption for the run. Snake-case keys match the AFPS wire format emitted by every runner (PiRunner / remote CLI / GitHub Action) and stored verbatim in JSONB.",
        properties: {
          input_tokens: { type: "integer", minimum: 0 },
          output_tokens: { type: "integer", minimum: 0 },
          cache_creation_input_tokens: { type: "integer", minimum: 0 },
          cache_read_input_tokens: { type: "integer", minimum: 0 },
        },
        // Stored verbatim from the runner's JSONB — a runner may emit provider-
        // specific extra keys beyond the four documented above. additionalProperties
        // stays `true` so those pass-through keys don't fail spec==runtime validation.
        additionalProperties: true,
      },
      started_at: { type: ["string", "null"], format: "date-time" },
      completed_at: { type: ["string", "null"], format: "date-time" },
      duration: { type: ["integer", "null"], description: "Duration in milliseconds" },
      scheduleId: { type: ["string", "null"] },
      version_label: {
        type: ["string", "null"],
        description:
          "Version label at run time (e.g. '1.0.0'). For draft runs this is the latest published version the draft sits on top of — read `version_ref` to know which definition actually executed.",
      },
      version_ref: {
        type: "string",
        description:
          "Unambiguous reference to the agent definition the run executed: 'draft' when the mutable draft ran with unpublished changes (or the agent has no published version), or the concrete semver (e.g. '2.1.0') when the run executed that published definition (or a draft identical to it).",
      },
      proxy_label: { type: ["string", "null"], description: "Proxy label used at run time" },
      model_label: { type: ["string", "null"], description: "Model label used at run time" },
      model_source: {
        type: ["string", "null"],
        description:
          "Model source: 'system' (platform-provided) or 'org' (user-configured). Resolved at run creation — an org-default change between triggers applies to subsequent runs unless the run was pinned via the runAgent `modelId` override.",
      },
      cost: { type: ["number", "null"], description: "Run cost in dollars" },
      endUserId: {
        type: ["string", "null"],
        description: "End-user ID (eu_ prefix) if executed on behalf of an end-user",
      },
      apiKeyId: {
        type: ["string", "null"],
        description: "API key ID that triggered the run (null for dashboard/schedule runs)",
      },
      applicationId: {
        type: "string",
        description: "Application ID (app_ prefix) that owns this run",
      },
      metadata: {
        type: ["object", "null"],
        description:
          "Additional module-supplied metadata (e.g. usage-metering fields written by an optional module). Free-form; core does not define billing-specific keys.",
        additionalProperties: true,
      },
      config: {
        type: ["object", "null"],
        description: "Snapshot of the effective agent config (merged overrides) at run creation",
        additionalProperties: true,
      },
      config_override: {
        type: ["object", "null"],
        description:
          "Per-run config delta — the raw object the caller sent in the request body. `config` is the resolved (deep-merged) snapshot; `config_override` is the raw delta that the dashboard uses to badge 'default vs override'. Null when the run used persisted defaults verbatim.",
        additionalProperties: true,
      },
      user_name: {
        type: ["string", "null"],
        description:
          "Display name of the dashboard user who triggered the run (from profiles table)",
      },
      end_user_name: {
        type: ["string", "null"],
        description: "Display name of the end-user (name or externalId fallback)",
      },
      api_key_name: {
        type: ["string", "null"],
        description: "Name of the API key that triggered the run",
      },
      schedule_name: {
        type: ["string", "null"],
        description: "Name of the schedule that triggered the run",
      },
      runner_name: {
        type: ["string", "null"],
        description:
          "Human-friendly label for the runner that triggered the run — CLI host (`os.hostname()`), GitHub Action workflow, or whatever the caller passes via `X-Appstrate-Runner-Name`. Stamped at INSERT and never updated.",
      },
      runner_kind: {
        type: ["string", "null"],
        description:
          "Free-form classifier driving the dashboard icon (`cli`, `github-action`, …). Sourced from `X-Appstrate-Runner-Kind` or inferred from the auth context.",
      },
      agent_scope: {
        type: ["string", "null"],
        description:
          "Denormalized agent scope at run creation, including the leading `@` (e.g. `@myorg`). Survives rename, delete, or shadow compaction — the global run view falls back to this when the source package is gone.",
      },
      agent_name: {
        type: ["string", "null"],
        description: "Denormalized agent name at run creation (see agent_scope).",
      },
      package_ephemeral: {
        type: "boolean",
        description:
          "Present on enriched run responses. True when the source package is an inline-run shadow (POST /api/runs/inline).",
      },
      inline_manifest: {
        type: ["object", "null"],
        description:
          "Inline runs only. Snapshot of the manifest submitted at run time. Null once the shadow has been compacted (see INLINE_RUN_LIMITS.retention_days).",
        additionalProperties: true,
      },
      inline_prompt: {
        type: ["string", "null"],
        description:
          "Inline runs only. Snapshot of the prompt submitted at run time. Null once the shadow has been compacted.",
      },
      unread: {
        type: "boolean",
        description:
          "True when the requesting recipient has an unread notification for this run (issue #667). Per-recipient: derived from the notifications table for the current actor, so a dashboard user and an end-user see independent state. Drives the unread dot on run rows and the per-schedule unread count.",
      },
      runNumber: {
        type: ["integer", "null"],
        description:
          "Per-(app, package) monotonic counter assigned at run creation. Stable identifier for UI display.",
      },
      // CASING: `runOrigin`/`contextSnapshot` are camelCase on the wire even
      // though they are neither *Id nor timestamp fields (the general rule would
      // make them `run_origin`/`context_snapshot`). This is a documented module
      // carve-out: the run serializer (`services/state/runs.ts`) emits the camel
      // keys verbatim from the Drizzle model, so the spec matches the runtime
      // (spec==runtime invariant). Do not rename without changing the serializer.
      runOrigin: {
        type: ["string", "null"],
        enum: ["platform", "remote", null],
        description:
          "Which runner drives this run: 'platform' (server-managed Docker container) or 'remote' (caller's host via signed events).",
      },
      contextSnapshot: {
        type: ["object", "null"],
        description:
          "Runner-provided execution environment metadata (os, cli version, git sha, ...) stamped at run creation.",
        additionalProperties: true,
      },
      modelCredentialId: {
        type: ["string", "null"],
        description:
          "ID of the model_provider_credentials row resolved at run creation (audit + cost-attribution).",
      },
      connection_overrides: {
        type: ["object", "null"],
        description:
          'Per-integration connection picks for this run (flat-connections mechanism #2). Flat map: `{ "@scope/integration": "<connection_id>" }` — one connection per integration; the chosen connection carries its own authKey. Loses to admin pins (#1).',
        additionalProperties: { type: "string" },
      },
      dependency_overrides: {
        type: ["object", "null"],
        description:
          'Per-run dependency version overrides (#666). Flat map: `{ "@scope/skill": "draft" | "<semver|dist-tag>" }`. A `"draft"` value means the run consumed a dependency\'s mutable working copy — so it is NOT reproducible from `version_ref` alone. Null when the run resolved the manifest pins verbatim against published versions.',
        additionalProperties: { type: "string" },
      },
      connections_used: {
        type: ["array", "null"],
        description:
          "Connections resolved for this run, projected from the internal snapshot for display. Null when the agent declares no integrations.",
        items: {
          type: "object",
          required: ["integration_id", "label", "account_id", "source"],
          properties: {
            integration_id: { type: "string" },
            label: { type: ["string", "null"] },
            account_id: { type: ["string", "null"] },
            source: { type: "string" },
          },
        },
      },
    },
  },
  RunLog: {
    type: "object",
    required: ["id", "runId", "type", "level", "createdAt"],
    properties: {
      id: { type: "integer" },
      runId: { type: "string" },
      orgId: { type: "string" },
      type: { type: "string" },
      level: {
        type: "string",
        enum: ["debug", "info", "warn", "error"],
        description: "Log severity level. Non-admin users only receive info, warn, and error logs.",
      },
      // `event` / `message` / `data` are nullable columns on `run_logs`
      // (no NOT NULL) — a breadcrumb may carry only a message, only structured
      // data, or only an event kind. Mirror that on the wire.
      event: { type: ["string", "null"] },
      message: { type: ["string", "null"] },
      data: { type: ["object", "null"] },
      createdAt: { type: "string", format: "date-time" },
    },
  },
  Schedule: {
    type: "object",
    // Every schedule response routes through `toSchedule` + `enrichSchedules`
    // (services/scheduler.ts) — list, detail, create, and update all return the
    // actor-enriched shape — so the full field set is guaranteed. Exhaustive
    // `required` lets the SPA drop its `as EnrichedSchedule` casts and lets
    // verify-openapi step 7 guard it against `EnrichedSchedule` drift.
    required: [
      "id",
      "packageId",
      "userId",
      "endUserId",
      "orgId",
      "applicationId",
      "name",
      "enabled",
      "cron_expression",
      "timezone",
      "input",
      "config_override",
      "model_id_override",
      "proxy_id_override",
      "version_override",
      "connection_overrides",
      "dependency_overrides",
      "last_run_at",
      "next_run_at",
      "createdAt",
      "updatedAt",
      "actor_name",
      "actor_type",
    ],
    properties: {
      id: { type: "string" },
      packageId: { type: "string" },
      userId: { type: ["string", "null"], description: "Member actor the schedule runs as" },
      endUserId: { type: ["string", "null"], description: "End-user actor the schedule runs as" },
      orgId: { type: "string" },
      applicationId: {
        type: "string",
        description: "Application ID (app_ prefix) that owns this schedule",
      },
      name: { type: ["string", "null"] },
      enabled: { type: "boolean" },
      cron_expression: { type: "string" },
      timezone: { type: ["string", "null"] },
      input: { type: ["object", "null"], additionalProperties: true },
      config_override: { type: ["object", "null"], additionalProperties: true },
      model_id_override: { type: ["string", "null"] },
      proxy_id_override: { type: ["string", "null"] },
      version_override: { type: ["string", "null"] },
      connection_overrides: {
        type: ["object", "null"],
        description:
          'Per-integration connection picks frozen on the schedule row (flat-connections mechanism #3). Flat map: `{ "@scope/integration": "<connection_id>" }`. Replayed on every fire; loses to admin pins (#1), beats actor-fallback (#4).',
        additionalProperties: { type: "string" },
      },
      dependency_overrides: {
        type: ["object", "null"],
        description:
          'Per-dependency version overrides frozen on the schedule row (#666/#686). Flat map: `{ "@scope/dep": "draft" | "<semver|dist-tag>" }`; keys may name a declared skill OR integration. Forwarded to each fired run\'s `dependency_overrides` so a scheduled run resolves its dependencies exactly as the schedule froze them.',
        additionalProperties: { type: "string" },
      },
      last_run_at: { type: ["string", "null"], format: "date-time" },
      next_run_at: { type: ["string", "null"], format: "date-time" },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
      actor_name: { type: ["string", "null"], description: "Display name of the schedule actor" },
      actor_type: { type: ["string", "null"], enum: ["user", "end_user", null] },
    },
  },
  ApiKeyInfo: {
    type: "object",
    // created_by/expiresAt/lastUsedAt/revokedAt are always emitted by
    // listApiKeys (nullable columns, always selected). created_by_name stays
    // optional (omitted when the creator is unknown).
    required: [
      "id",
      "name",
      "keyPrefix",
      "scopes",
      "created_by",
      "expiresAt",
      "lastUsedAt",
      "revokedAt",
      "createdAt",
    ],
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      keyPrefix: { type: "string", description: "First 8 chars of the key for identification" },
      scopes: {
        type: "array",
        items: { type: "string" },
        description: "Permission scopes granted to this API key.",
      },
      created_by: { type: ["string", "null"] },
      created_by_name: { type: "string" },
      expiresAt: { type: ["string", "null"], format: "date-time" },
      lastUsedAt: { type: ["string", "null"], format: "date-time" },
      revokedAt: { type: ["string", "null"], format: "date-time" },
      createdAt: { type: "string", format: "date-time" },
    },
  },
  OrgPackageItem: {
    type: "object",
    // Always emitted by the listOrgItems mapper. `created_by_name` stays
    // optional (omitted when there's no creator); `scope` is not emitted by
    // the org-package list (shared-type marks it optional).
    required: [
      "id",
      "source",
      "createdAt",
      "updatedAt",
      "name",
      "description",
      "created_by",
      "used_by_agents",
      "version",
      "auto_installed",
      "forked_from",
    ],
    properties: {
      id: { type: "string" },
      orgId: {
        type: ["string", "null"],
        description: "Owning organization ID (null for system packages)",
      },
      name: { type: "string" }, // getPackageDisplayName always returns a string (falls back to id)
      description: { type: ["string", "null"] },
      source: { type: "string", enum: ["system", "local"] },
      created_by: { type: ["string", "null"] },
      created_by_name: { type: "string" },
      used_by_agents: { type: "integer" },
      version: { type: ["string", "null"], description: "Manifest version (semver)" },
      auto_installed: { type: "boolean" },
      forked_from: { type: ["string", "null"], description: "Source package ID if forked" },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
  },
  OrgPackageItemDetail: {
    type: "object",
    // Always emitted by buildPackageDetailDto. `content` is present but the
    // draft_content column is nullable, so it is required-but-nullable. The
    // detail endpoint does not emit `used_by_agents`/`created_by_name`/`scope`
    // (the shared-type marks those optional on the detail shape).
    required: [
      "id",
      "source",
      "createdAt",
      "updatedAt",
      "name",
      "description",
      "content",
      "created_by",
      "version",
      "auto_installed",
      "forked_from",
      "agents",
    ],
    properties: {
      id: { type: "string" },
      orgId: {
        type: ["string", "null"],
        description: "Owning organization ID (null for system packages)",
      },
      name: { type: "string" }, // getPackageDisplayName always returns a string (falls back to id)
      description: { type: ["string", "null"] },
      content: { type: ["string", "null"], description: "Package item content" },
      source_code: {
        type: ["string", "null"],
        description: "Secondary source file content (e.g. .ts for tools)",
      },
      source: { type: "string", enum: ["system", "local"] },
      created_by: { type: ["string", "null"] },
      auto_installed: { type: "boolean" },
      lock_version: { type: "integer", description: "Optimistic lock version" },
      version: { type: ["string", "null"], description: "Manifest version (semver)" },
      manifest: { type: "object", description: "Full manifest object" },
      manifest_name: {
        type: ["string", "null"],
        description: "Manifest name (@scope/name) — may differ from package ID",
      },
      version_count: {
        type: "integer",
        description: "Number of published versions",
      },
      has_unarchived_changes: {
        type: "boolean",
        description: "Whether the active version has changes not yet archived as a version",
      },
      forked_from: { type: ["string", "null"], description: "Source package ID if forked" },
      agents: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "display_name"],
          properties: {
            id: { type: "string" },
            display_name: { type: "string" },
          },
        },
      },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
  },
  ModelProviderCredential: {
    type: "object",
    required: [
      "id",
      "label",
      "apiShape",
      "baseUrl",
      "source",
      "authMode",
      "created_by",
      "createdAt",
      "updatedAt",
    ],
    properties: {
      id: { type: "string" },
      label: { type: "string" },
      apiShape: {
        type: ["string", "null"],
        description:
          "Protocol family. `null` for a built-in credential whose every model is managed (#727) — the binding is not exposed, so the endpoint doesn't reveal the provider.",
      },
      baseUrl: {
        type: ["string", "null"],
        description:
          "Endpoint base URL. `null` for a managed-only built-in credential (see apiShape).",
      },
      source: { type: "string", enum: ["built-in", "custom"] },
      authMode: { type: "string", enum: ["api_key", "oauth2"] },
      providerId: {
        type: ["string", "null"],
        description:
          "Canonical providerId backing the credential. Set when `authMode === 'oauth2'`.",
      },
      oauth_email: { type: ["string", "null"] },
      needs_reconnection: { type: "boolean" },
      available_model_ids: {
        type: ["array", "null"],
        items: { type: "string" },
        description:
          "Model ids this credential is authorized to seed, persisted by model discovery (POST /:id/refresh-models, also fired after OAuth import) — the server-side authorization record gating model seeding. For `probe`-validation (API-key) providers these are empirically verified against the live credential; for `offline`-validation providers (subscription: codex, claude-code) these are the provider's static candidate set (∩ catalog), persisted with zero upstream calls. Null = discovery never ran. Per-credential because availability depends on the account's plan.",
      },
      created_by: { type: ["string", "null"] },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
  },
  OrgModel: {
    type: "object",
    required: [
      "id",
      "label",
      "apiShape",
      "providerId",
      "providerName",
      "baseUrl",
      "modelId",
      "enabled",
      "is_default",
      "aliased",
      "iconUrl",
      "source",
      "credentialId",
      "created_by",
      "createdAt",
      "updatedAt",
    ],
    properties: {
      id: { type: "string" },
      label: { type: "string" },
      apiShape: {
        type: ["string", "null"],
        description:
          "Protocol family. `null` for managed models (`aliased: true`) — binding not exposed.",
      },
      providerId: {
        type: ["string", "null"],
        description:
          "The credential's provider id (e.g. `anthropic`, `claude-code`, `codex`). Distinguishes subscription providers that share an `apiShape` with an API-key provider so clients route them to the right proxy path. `null` for managed models — binding not exposed.",
      },
      providerName: {
        type: ["string", "null"],
        description:
          "The provider's human display name resolved from the model-provider registry by `providerId` (e.g. `OpenCode Go`, `OpenAI`). The authoritative label for grouping/badging a model by provider — `apiShape` is ambiguous (OpenCode Go and OpenAI both use `openai-completions`), so do NOT derive a provider label from it. `null` for managed models (binding not exposed) and for rows whose `providerId` has no registry entry.",
      },
      baseUrl: {
        type: ["string", "null"],
        description: "Provider endpoint. `null` for managed models — binding not exposed.",
      },
      modelId: {
        type: ["string", "null"],
        description: "Upstream model id. `null` for managed models — not exposed.",
      },
      input: { type: ["array", "null"], items: { type: "string" } },
      contextWindow: { type: ["integer", "null"] },
      maxTokens: { type: ["integer", "null"] },
      reasoning: { type: ["boolean", "null"] },
      enabled: { type: "boolean" },
      is_default: { type: "boolean" },
      aliased: {
        type: "boolean",
        description:
          "Managed-model flag. When true, the binding (`modelId`, `apiShape`, `baseUrl`, `credentialId`, capabilities/cost) is not exposed in this projection — these fields are `null`; render a managed badge.",
      },
      iconUrl: {
        type: ["string", "null"],
        description:
          "Display-icon key for the UI (a client provider-icon key, e.g. `anthropic`, `openai`). A deliberate public choice on the model — decoupled from the provider, so a managed model can show an icon without exposing its binding. `null` means resolve the icon from the (visible) `apiShape`/`baseUrl`, or fall back to a generic icon.",
      },
      source: { type: "string", enum: ["built-in", "custom"] },
      credentialId: {
        type: ["string", "null"],
        description:
          "ID of the `model_provider_credentials` row. `null` for managed models — binding not exposed.",
      },
      cost: {
        type: ["object", "null"],
        description: "Cost per million tokens",
        properties: {
          input: { type: "number" },
          output: { type: "number" },
          cacheRead: { type: "number" },
          cacheWrite: { type: "number" },
        },
      },
      created_by: { type: ["string", "null"] },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
  },
  TestResult: {
    type: "object",
    required: ["ok", "latency"],
    properties: {
      ok: { type: "boolean" },
      latency: { type: "number", description: "Response time in milliseconds" },
      error: { type: "string", description: "Error code if test failed" },
      message: { type: "string", description: "Human-readable error message" },
      status: {
        type: "integer",
        description:
          "Upstream HTTP status when the provider answered at all — distinguishes 429 (retry later) from 404 (model not served).",
      },
    },
  },
  OAuthTokenResponse: {
    type: "object",
    description:
      "Resolved access token returned by `GET /internal/oauth-token/{id}` and `POST .../refresh`. Carries only the fields that change per refresh — provider invariants (baseUrl, …) live in the sidecar's boot-time `LlmProxyOauthConfig`. Wire-equivalent to the `OAuthTokenResponse` TS interface in `@appstrate/core/sidecar-types`.",
    required: ["accessToken", "expiresAt"],
    properties: {
      accessToken: { type: "string" },
      expiresAt: {
        type: ["integer", "null"],
        description: "Epoch milliseconds. null when expiry is unknown.",
      },
      accountId: {
        type: "string",
        description:
          "Abstract account/tenant identifier surfaced by the provider's `extractTokenIdentity` hook. The sidecar's identity layer (keyed by providerId from the boot config) decides which routing header to echo it as.",
      },
    },
  },
  IntegrationCredentialsResponse: {
    type: "object",
    description:
      "Live credentials + per-auth HTTP delivery plans + per-auth expiries for an installed integration. Returned by both `GET /internal/integration-credentials/{scope}/{name}` and `POST .../refresh` (identical shape). Feeds the sidecar's MITM `MitmCredentialSource.current()` + `.deliveryPlans()`. All wire keys are snake_case per AFPS (see `docs/CASING_CONVENTIONS.md` — internal sidecar↔platform endpoints share the Zone 1 default).",
    required: ["auths", "delivery_plans", "expires_at_epoch_ms"],
    properties: {
      auths: {
        type: "array",
        items: {
          type: "object",
          required: ["auth_key", "auth_type", "fields", "authorized_uris"],
          properties: {
            auth_key: { type: "string" },
            auth_type: { type: "string" },
            fields: { type: "object", additionalProperties: { type: "string" } },
            authorized_uris: { type: "array", items: { type: "string" } },
            resource: {
              type: "string",
              description:
                "RFC 8707 resource indicator declared by the manifest (`auths.{key}.resource`). AFPS §7.3 name — matches the RFC.",
            },
            expires_at: { type: "string", format: "date-time" },
            scopes_granted: { type: "array", items: { type: "string" } },
          },
        },
      },
      delivery_plans: {
        type: "object",
        additionalProperties: {
          type: "object",
          required: ["header_name", "header_prefix", "value", "allow_server_override"],
          properties: {
            header_name: { type: "string" },
            header_prefix: { type: "string" },
            value: { type: "string" },
            allow_server_override: { type: "boolean" },
          },
        },
      },
      expires_at_epoch_ms: {
        type: "object",
        additionalProperties: { type: ["integer", "null"] },
      },
    },
  },
  IntegrationAgentResolution: {
    type: "object",
    description:
      "Per-integration connection verdict for an agent: which connection the next run uses (admin pin → run/schedule override → member pin → fallback + scope check), the annotated candidate list, and admin/member pin + blocked state. Computed by the same resolver the runtime uses.",
    required: [
      "status",
      "resolved_connection_id",
      "resolved_missing_scopes",
      "resolved_owned_by_actor",
      "admin_pinned_connection_id",
      "member_pinned_connection_id",
      "org_default_connection_id",
      "org_default_enforced",
      "can_add_connection",
      "candidates",
    ],
    properties: {
      status: {
        type: "string",
        enum: [
          "admin_locked",
          "pinned",
          "auto",
          "must_choose",
          "none",
          "stale",
          "needs_reconnection",
        ],
      },
      resolved_connection_id: { type: ["string", "null"] },
      resolved_missing_scopes: { type: "array", items: { type: "string" } },
      resolved_owned_by_actor: { type: "boolean" },
      admin_pinned_connection_id: { type: ["string", "null"] },
      member_pinned_connection_id: { type: ["string", "null"] },
      org_default_connection_id: { type: ["string", "null"] },
      org_default_enforced: { type: "boolean" },
      can_add_connection: { type: "boolean" },
      candidates: {
        type: "array",
        items: {
          type: "object",
          required: [
            "id",
            "auth_key",
            "account_id",
            "label",
            "owner_user_id",
            "owner_end_user_id",
            "owner_name",
            "scopes_granted",
            "shared_with_org",
            "needs_reconnection",
            "missing_scopes",
            "is_own",
          ],
          properties: {
            id: { type: "string", format: "uuid" },
            auth_key: { type: "string" },
            account_id: { type: "string" },
            label: { type: ["string", "null"] },
            owner_user_id: { type: ["string", "null"] },
            owner_end_user_id: { type: ["string", "null"] },
            owner_name: { type: ["string", "null"] },
            scopes_granted: { type: "array", items: { type: "string" } },
            shared_with_org: { type: "boolean" },
            needs_reconnection: { type: "boolean" },
            missing_scopes: { type: "array", items: { type: "string" } },
            is_own: { type: "boolean" },
          },
        },
      },
    },
  },
  AgentConnectionReadiness: {
    type: "object",
    description:
      "Bulk integration connection readiness for an agent. `blocks_run`/`errors` mirror the run-kickoff 412 (run semantics); `integrations[]` carries every declared integration's management verdict for the Connexions tab.",
    required: ["blocks_run", "errors", "integrations"],
    properties: {
      blocks_run: {
        type: "boolean",
        description: "True iff POST /api/agents/{scope}/{name}/run would reject with 412.",
      },
      errors: {
        type: "array",
        description:
          "Integration portion of the 412 envelope (same `field: integrations.<id>` shape as ProblemDetail.errors). Shares the single ResolutionFieldError component so the shape can't drift from the 412 error items.",
        items: { $ref: "#/components/schemas/ResolutionFieldError" },
      },
      integrations: {
        type: "array",
        items: {
          type: "object",
          required: ["integration_id", "run_blocking", "resolution"],
          properties: {
            integration_id: { type: "string" },
            run_blocking: {
              type: "boolean",
              description: "True iff this integration is one of the run-blocking `errors`.",
            },
            resolution: { $ref: "#/components/schemas/IntegrationAgentResolution" },
          },
        },
      },
    },
  },
  IntegrationPin: {
    type: "object",
    required: [
      "packageId",
      "integration_package_id",
      "auth_key",
      "connection_id",
      "createdAt",
      "updatedAt",
    ],
    properties: {
      packageId: { type: "string" },
      integration_package_id: { type: "string" },
      auth_key: { type: "string" },
      connection_id: { type: "string", format: "uuid" },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
  },
  OrgProxy: {
    type: "object",
    required: [
      "id",
      "label",
      "urlPrefix",
      "enabled",
      "is_default",
      "source",
      "created_by",
      "createdAt",
      "updatedAt",
    ],
    properties: {
      id: { type: "string" },
      label: { type: "string" },
      urlPrefix: { type: "string", description: "Masked proxy URL for display" },
      enabled: { type: "boolean" },
      is_default: { type: "boolean" },
      source: { type: "string", enum: ["built-in", "custom"] },
      created_by: { type: ["string", "null"] },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
  },
  ApplicationObject: {
    type: "object",
    required: [
      "id",
      "object",
      "orgId",
      "name",
      "isDefault",
      "settings",
      "created_by",
      "createdAt",
      "updatedAt",
    ],
    properties: {
      id: { type: "string", description: "Application ID (app_ prefix)" },
      object: { type: "string", enum: ["application"], description: "Object type" },
      orgId: { type: "string", description: "Organization ID" },
      name: { type: "string", description: "Human-readable application name" },
      isDefault: { type: "boolean", description: "Whether this is the default application" },
      settings: {
        type: "object",
        properties: {
          allowedRedirectDomains: {
            type: "array",
            items: { type: "string" },
            description: "Domains allowed for OAuth redirect callbacks",
          },
        },
      },
      created_by: {
        type: ["string", "null"],
        description: "ID of the user who created the application",
      },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
  },
  EndUserObject: {
    type: "object",
    // Every field is always serialized (toEndUserResponse in services/end-users.ts);
    // nullable fields are required-but-null on the wire, not omitted.
    required: [
      "id",
      "object",
      "applicationId",
      "name",
      "email",
      "externalId",
      "metadata",
      "createdAt",
      "updatedAt",
    ],
    properties: {
      id: { type: "string", description: "End-user ID (eu_ prefix)" },
      object: { type: "string", enum: ["end_user"], description: "Object type" },
      applicationId: { type: "string", description: "ID of the parent application" },
      name: { type: ["string", "null"], description: "Display name" },
      email: { type: ["string", "null"], format: "email", description: "Email address" },
      externalId: { type: ["string", "null"], description: "External system identifier" },
      metadata: {
        type: ["object", "null"],
        additionalProperties: true,
        description: "Arbitrary key-value metadata",
      },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
  },
  AgentManifest: {
    description:
      "AFPS Agent manifest extended with Appstrate platform fields. " +
      "Standard fields are defined by the AFPS Agent schema. Most extension fields use the x- prefix per AFPS §10, " +
      "with the exception of the Appstrate-specific top-level `runtime_tools` field documented below.",
    allOf: [
      { $ref: "https://schemas.afps.dev/v0/agent.schema.json" },
      {
        type: "object",
        properties: {
          runtime_tools: {
            type: "array",
            items: { type: "string", enum: ["output", "log", "note", "pin", "report"] },
            description:
              "Appstrate top-level extension: runtime tools the agent may use. Optional.",
          },
        },
      },
    ],
  },
  FileConstraintsMap: {
    type: "object",
    description:
      "Upload constraints for file fields, keyed by property name. " +
      "Lives at the AFPS wrapper level (outside the JSON Schema).",
    additionalProperties: {
      type: "object",
      properties: {
        accept: {
          type: "string",
          description: "Comma-separated accepted file extensions (e.g. .pdf,.docx)",
        },
        max_size: {
          type: "number",
          description: "Maximum file size in bytes",
        },
      },
    },
  },
  UIHintsMap: {
    type: "object",
    description:
      "UI rendering hints for schema fields, keyed by property name. " +
      "Lives at the AFPS wrapper level (outside the JSON Schema).",
    additionalProperties: {
      type: "object",
      properties: {
        placeholder: {
          type: "string",
          description: "Hint text shown before the user provides a value",
        },
      },
    },
  },
  LibraryPackageList: {
    type: "array",
    description:
      "Packages of a single type visible to the org. Each entry carries an " +
      "`installed_in` array listing the caller-org applications where the package " +
      "is currently installed (empty array = not installed in any of the caller's apps).",
    items: {
      type: "object",
      required: ["id", "type", "source", "name", "description", "installed_in"],
      properties: {
        id: { type: "string", description: "Package id (`pkg_…`)." },
        type: { type: "string", enum: ["agent", "skill", "mcp-server", "integration"] },
        source: {
          type: "string",
          description:
            "Package origin (`local` for org-owned packages, `system` for built-in system packages).",
        },
        name: {
          type: "string",
          description:
            "Display name from the package draft manifest (`manifest.display_name`); falls back to the package id.",
        },
        description: {
          type: "string",
          description:
            "Description from the package draft manifest; empty string when not provided.",
        },
        installed_in: {
          type: "array",
          description:
            "Application ids (`app_…`) belonging to the caller's org where this package is installed.",
          items: { type: "string" },
        },
      },
    },
  },

  // ─── Desktop bridge ───────────────────────────────────────────────
  //
  // Shared by the user-facing `/api/desktop/me/command` smoke-test route
  // and the sidecar-facing `/internal/desktop-command`, so the two
  // surfaces can't drift. `params` is deliberately open: its shape
  // varies per method and the desktop client validates it.
  DesktopCommandRequest: {
    type: "object",
    required: ["method"],
    description: "A browser primitive to execute on the user's local Appstrate Desktop client.",
    properties: {
      method: {
        type: "string",
        enum: [
          "browser.navigate",
          "browser.click",
          "browser.fill",
          "browser.evaluate",
          "browser.screenshot",
          "browser.waitForSelector",
        ],
        description: "Browser primitive to invoke.",
      },
      params: {
        type: "object",
        description: "Method-specific arguments (e.g. `{ url }`, `{ selector, value }`).",
      },
      timeoutMs: {
        type: "integer",
        minimum: 1000,
        maximum: 120000,
        description: "Dispatch timeout in ms (1s–120s, default 30s). 504 when it elapses.",
      },
    },
  },
  DesktopCommandResponse: {
    type: "object",
    required: ["result"],
    description: "The desktop client's reply, forwarded verbatim.",
    properties: {
      result: {
        description:
          "Method-specific result — e.g. `{ url }` for navigate, `{ dataUrl }` for screenshot, the evaluated value for evaluate.",
      },
    },
  },
  DesktopStatusResponse: {
    type: "object",
    required: ["connected"],
    description: "Whether the caller currently has a desktop companion connected.",
    properties: {
      connected: { type: "boolean" },
    },
  },
} as const;
