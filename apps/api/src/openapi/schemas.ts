// SPDX-License-Identifier: Apache-2.0

import { orgRoleEnum } from "@appstrate/db/schema";

const ORG_ROLES = [...orgRoleEnum.enumValues];

/**
 * All OpenAPI schema definitions (components/schemas).
 */
export const schemas = {
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
        items: {
          type: "object",
          properties: {
            field: { type: "string" },
            code: { type: "string" },
            title: {
              type: "string",
              description: "Human-readable title; preserved from the underlying error factory.",
            },
            message: { type: "string" },
            // Channel-specific smuggles surfaced by services/integration-connection-resolver.ts:translateResolutionError.
            // Documented here so SDK consumers can rely on them without reading the resolver source.
            candidateConnectionIds: {
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
      },
    },
  },
  User: {
    type: "object",
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
    required: ["packageId", "enabled", "installed_at", "updatedAt"],
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
    },
  },
  OrgSettings: {
    type: "object",
    description: "Organization settings (extensible)",
    properties: {
      apiVersion: {
        type: "string",
        description:
          "Pinned API version for this organization (format: YYYY-MM-DD). Automatically set to the current version at org creation. New API versions do not affect existing orgs until explicitly updated.",
      },
      dashboardSsoEnabled: {
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
      displayName: { type: "string" },
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
    required: ["userId", "email", "role", "joinedAt"],
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
    required: ["id", "name"],
    properties: {
      id: { type: "string" },
      version: { type: "string" },
      name: { type: "string" },
      description: { type: "string" },
    },
  },
  AgentListItem: {
    type: "object",
    required: ["id", "source", "type"],
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
        description: "Scope from manifest name (e.g. @myorg from @myorg/name)",
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
    required: ["id", "source"],
    properties: {
      id: { type: "string" },
      display_name: { type: "string" },
      description: { type: "string" },
      source: { type: "string", enum: ["system", "local"] },
      scope: { type: ["string", "null"], description: "Scope from manifest name" },
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
        properties: {
          id: { type: "string" },
          status: { type: "string" },
          started_at: { type: "string", format: "date-time" },
          duration: { type: "integer" },
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
    properties: {
      id: { type: "integer" },
      packageId: { type: "string" },
      version: { type: "string", description: "Semver version string (e.g. 1.0.0)" },
      integrity: { type: "string", description: "SRI integrity hash (sha256-...)" },
      artifact_size: { type: "integer", description: "Artifact ZIP size in bytes" },
      yanked: { type: "boolean", description: "Whether this version has been yanked" },
      createdBy: { type: ["string", "null"] },
      createdAt: { type: ["string", "null"], format: "date-time" },
    },
  },
  Run: {
    type: "object",
    required: ["id", "orgId", "applicationId", "status", "version_dirty", "started_at"],
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
      input: { type: "object" },
      result: { type: "object" },
      checkpoint: { type: "object" },
      error: { type: "string" },
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
        additionalProperties: false,
      },
      started_at: { type: "string", format: "date-time" },
      completed_at: { type: "string", format: "date-time" },
      duration: { type: "integer", description: "Duration in milliseconds" },
      scheduleId: { type: "string" },
      version_label: {
        type: ["string", "null"],
        description: "Version label at run time (e.g. '1.0.0')",
      },
      version_dirty: {
        type: "boolean",
        description: "Whether the draft had unpublished changes at run time",
      },
      proxy_label: { type: ["string", "null"], description: "Proxy label used at run time" },
      model_label: { type: ["string", "null"], description: "Model label used at run time" },
      model_source: {
        type: ["string", "null"],
        description: "Model source: 'system' (platform-provided) or 'org' (user-configured)",
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
        type: ["string", "null"],
        description: "Application ID (app_ prefix) that owns this run",
      },
      metadata: {
        type: ["object", "null"],
        description: "Additional metadata (e.g. creditsUsed in cloud mode)",
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
          "Denormalized agent scope at run creation. Survives rename, delete, or shadow compaction — the global run view falls back to this when the source package is gone.",
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
      notifiedAt: {
        type: ["string", "null"],
        format: "date-time",
        description:
          "When the user was notified of run completion (in-app notification). Null until notification fires.",
      },
      readAt: {
        type: ["string", "null"],
        format: "date-time",
        description: "When the user marked the run notification as read. Null until acknowledged.",
      },
      runNumber: {
        type: ["integer", "null"],
        description:
          "Per-(app, package) monotonic counter assigned at run creation. Stable identifier for UI display.",
      },
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
    },
  },
  RunLog: {
    type: "object",
    required: ["id", "runId", "type", "level", "createdAt"],
    properties: {
      id: { type: "integer" },
      runId: { type: "string" },
      userId: { type: "string" },
      orgId: { type: "string" },
      type: { type: "string" },
      level: {
        type: "string",
        enum: ["debug", "info", "warn", "error"],
        description: "Log severity level. Non-admin users only receive info, warn, and error logs.",
      },
      event: { type: "string" },
      message: { type: "string" },
      data: { type: "object" },
      createdAt: { type: "string", format: "date-time" },
    },
  },
  Schedule: {
    type: "object",
    required: [
      "id",
      "packageId",
      "orgId",
      "applicationId",
      "cron_expression",
      "createdAt",
      "updatedAt",
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
      enabled: { type: ["boolean", "null"] },
      cron_expression: { type: "string" },
      timezone: { type: ["string", "null"] },
      input: { type: "object" },
      config_override: { type: ["object", "null"] },
      model_id_override: { type: ["string", "null"] },
      proxy_id_override: { type: ["string", "null"] },
      version_override: { type: ["string", "null"] },
      connection_overrides: {
        type: ["object", "null"],
        description:
          'Per-integration connection picks frozen on the schedule row (flat-connections mechanism #3). Flat map: `{ "@scope/integration": "<connection_id>" }`. Replayed on every fire; loses to admin pins (#1), beats actor-fallback (#4).',
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
    required: ["id", "name", "keyPrefix", "scopes", "createdAt"],
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      keyPrefix: { type: "string", description: "First 8 chars of the key for identification" },
      scopes: {
        type: "array",
        items: { type: "string" },
        description: "Permission scopes granted to this API key.",
      },
      createdBy: { type: ["string", "null"] },
      created_by_name: { type: "string" },
      expiresAt: { type: ["string", "null"], format: "date-time" },
      lastUsedAt: { type: ["string", "null"], format: "date-time" },
      revokedAt: { type: ["string", "null"], format: "date-time" },
      createdAt: { type: "string", format: "date-time" },
    },
  },
  OrgPackageItem: {
    type: "object",
    required: ["id", "source", "createdAt", "updatedAt"],
    properties: {
      id: { type: "string" },
      name: { type: ["string", "null"] },
      description: { type: ["string", "null"] },
      source: { type: "string", enum: ["system", "local"] },
      scope: {
        type: ["string", "null"],
        description: "Scope from manifest name (e.g. @myorg from @myorg/name)",
      },
      createdBy: { type: ["string", "null"] },
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
    required: ["id", "source", "createdAt", "updatedAt"],
    properties: {
      id: { type: "string" },
      name: { type: ["string", "null"] },
      description: { type: ["string", "null"] },
      content: { type: "string", description: "Package item content" },
      source_code: {
        type: ["string", "null"],
        description: "Secondary source file content (e.g. .ts for tools)",
      },
      source: { type: "string", enum: ["system", "local"] },
      scope: {
        type: ["string", "null"],
        description: "Scope from manifest name (e.g. @myorg from @myorg/name)",
      },
      createdBy: { type: ["string", "null"] },
      created_by_name: { type: "string" },
      used_by_agents: { type: "integer" },
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
      "createdAt",
      "updatedAt",
    ],
    properties: {
      id: { type: "string" },
      label: { type: "string" },
      apiShape: { type: "string" },
      baseUrl: { type: "string" },
      source: { type: "string", enum: ["built-in", "custom"] },
      authMode: { type: "string", enum: ["api_key", "oauth2"] },
      providerId: {
        type: ["string", "null"],
        description:
          "Canonical providerId backing the credential. Set when `authMode === 'oauth2'`.",
      },
      oauthEmail: { type: ["string", "null"] },
      needsReconnection: { type: "boolean" },
      createdBy: { type: ["string", "null"] },
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
      "baseUrl",
      "modelId",
      "enabled",
      "isDefault",
      "source",
      "credentialId",
      "createdAt",
      "updatedAt",
    ],
    properties: {
      id: { type: "string" },
      label: { type: "string" },
      apiShape: { type: "string" },
      baseUrl: { type: "string" },
      modelId: { type: "string" },
      input: { type: ["array", "null"], items: { type: "string" } },
      contextWindow: { type: ["integer", "null"] },
      maxTokens: { type: ["integer", "null"] },
      reasoning: { type: ["boolean", "null"] },
      enabled: { type: "boolean" },
      isDefault: { type: "boolean" },
      source: { type: "string", enum: ["built-in", "custom"] },
      credentialId: {
        type: "string",
        description: "ID of the backing `model_provider_credentials` row.",
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
      createdBy: { type: ["string", "null"] },
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
    },
  },
  OAuthTokenResponse: {
    type: "object",
    description:
      "Resolved access token returned by `GET /internal/oauth-token/{id}` and `POST .../refresh`. Carries only the fields that change per refresh — provider invariants (baseUrl, wireFormat, …) live in the sidecar's boot-time `LlmProxyOauthConfig`. Wire-equivalent to the `OAuthTokenResponse` TS interface in `@appstrate/core/sidecar-types`.",
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
            identity_claims: {
              type: "object",
              additionalProperties: { type: "string" },
              description:
                "Identity claims captured at connect time (e.g. OIDC `sub`, `email`). AFPS §7 name.",
            },
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
  OrgProxy: {
    type: "object",
    required: ["id", "label", "enabled", "isDefault", "source", "createdAt", "updatedAt"],
    properties: {
      id: { type: "string" },
      label: { type: "string" },
      urlPrefix: { type: "string", description: "Masked proxy URL for display" },
      enabled: { type: "boolean" },
      isDefault: { type: "boolean" },
      source: { type: "string", enum: ["built-in", "custom"] },
      createdBy: { type: ["string", "null"] },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
  },
  ApplicationObject: {
    type: "object",
    required: ["id", "object", "orgId", "name", "isDefault", "settings", "createdAt", "updatedAt"],
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
      createdBy: {
        type: ["string", "null"],
        description: "ID of the user who created the application",
      },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
  },
  EndUserObject: {
    type: "object",
    required: ["id", "object", "applicationId", "createdAt", "updatedAt"],
    properties: {
      id: { type: "string", description: "End-user ID (eu_ prefix)" },
      object: { type: "string", enum: ["end_user"], description: "Object type" },
      applicationId: { type: "string", description: "ID of the parent application" },
      name: { type: ["string", "null"], description: "Display name" },
      email: { type: ["string", "null"], format: "email", description: "Email address" },
      externalId: { type: ["string", "null"], description: "External system identifier" },
      metadata: { type: ["object", "null"], description: "Arbitrary key-value metadata" },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
  },
  AgentManifest: {
    description:
      "AFPS Agent manifest extended with Appstrate platform fields. " +
      "Standard fields are defined by the AFPS Agent schema; extension fields use the x- prefix per AFPS §10.",
    allOf: [{ $ref: "https://schemas.afps.dev/v0/agent.schema.json" }],
  },
  SkillManifest: {
    description: "AFPS Skill manifest. See https://schemas.afps.dev for field reference.",
    $ref: "https://schemas.afps.dev/v0/skill.schema.json",
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
            "Package origin (e.g. `org` for org-owned packages, `system` for built-in system packages).",
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
} as const;
