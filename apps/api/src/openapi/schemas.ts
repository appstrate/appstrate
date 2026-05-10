// SPDX-License-Identifier: Apache-2.0

import { orgRoleEnum } from "@appstrate/db/schema";

const ORG_ROLES = [...orgRoleEnum.enumValues];

// ─── Shared building blocks for ProviderConfig{,Input,Update} ───────────────
//
// The three provider-config schemas (read response, create input, update input)
// share most of their property bag verbatim. We expose the common pieces as
// JS-level constants and spread them into each schema, so the rendered OpenAPI
// stays flat (no `allOf`) — `verify-openapi.ts` reads `properties`/`required`
// directly off the resolved schema and does not chase `allOf` composition.

const providerAuthModeEnum = {
  type: "string",
  enum: ["oauth2", "oauth1", "api_key", "basic", "custom"],
} as const;

const providerTokenContentTypeProperty = {
  type: "string",
  enum: ["application/x-www-form-urlencoded", "application/json"],
  description:
    "Content-Type used for OAuth2 token endpoint request bodies. Defaults to application/x-www-form-urlencoded; set to application/json for providers like Atlassian/Jira that require a JSON body.",
} as const;

const providerCredentialTransformProperty = {
  type: "object",
  required: ["template", "encoding"],
  properties: {
    template: {
      type: "string",
      minLength: 1,
      description:
        "Free-form template with {{var}} placeholders resolved against the user-provided credential fields.",
    },
    encoding: {
      type: "string",
      enum: ["base64"],
      description:
        "Whitelisted post-substitution transform applied to the rendered template. AFPS v1: base64 only.",
    },
  },
  description:
    "Generic, template-based pre-encoding for api_key credentials. Lets manifests express any provider-specific Basic-auth convention (Freshdesk/Teamwork, Zendesk, …) without spec changes.",
} as const;

const providerAvailableScopesProperty = {
  type: "array",
  items: {
    type: "object",
    properties: {
      value: { type: "string" },
      label: { type: "string" },
    },
  },
} as const;

/**
 * Properties shared by ProviderConfigInput AND ProviderConfigUpdate.
 * Excludes `id` (Input-only, required) and `displayName` (different shape per schema).
 */
const providerInputSharedProperties = {
  version: { type: "string" },
  description: { type: "string" },
  author: { type: "string" },
  authMode: providerAuthModeEnum,
  clientId: { type: "string" },
  clientSecret: { type: "string" },
  authorizationUrl: { type: "string" },
  tokenUrl: { type: "string" },
  refreshUrl: { type: "string" },
  requestTokenUrl: { type: "string", description: "OAuth1 request token endpoint" },
  accessTokenUrl: { type: "string", description: "OAuth1 access token endpoint" },
  defaultScopes: { type: "array", items: { type: "string" } },
  scopeSeparator: { type: "string" },
  pkceEnabled: { type: "boolean" },
  tokenAuthMethod: { type: "string", enum: ["client_secret_post", "client_secret_basic"] },
  tokenContentType: providerTokenContentTypeProperty,
  authorizationParams: { type: "object" },
  tokenParams: { type: "object" },
  credentialSchema: { type: "object", description: "JSON Schema for custom credential fields" },
  credentialFieldName: { type: "string" },
  credentialHeaderName: { type: "string" },
  credentialHeaderPrefix: { type: "string" },
  credentialTransform: providerCredentialTransformProperty,
  availableScopes: providerAvailableScopesProperty,
  iconUrl: { type: "string" },
  categories: { type: "array", items: { type: "string" } },
  docsUrl: { type: "string" },
  authorizedUris: { type: "array", items: { type: "string" } },
  allowAllUris: { type: "boolean" },
} as const;

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
            message: { type: "string" },
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
    required: ["packageId", "enabled", "installedAt", "updatedAt"],
    properties: {
      object: { type: "string", enum: ["application_package"] },
      packageId: { type: "string", description: "Package ID from org catalog" },
      config: { type: "object", description: "Application-specific configuration" },
      modelId: { type: ["string", "null"], description: "Model override for this app" },
      proxyId: { type: ["string", "null"], description: "Proxy override for this app" },
      appProfileId: { type: ["string", "null"], description: "App profile override" },
      versionId: { type: ["integer", "null"], description: "Pinned version (null = latest)" },
      enabled: { type: "boolean" },
      installedAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
      packageType: { type: "string", enum: ["agent", "skill", "tool", "provider"] },
      packageSource: { type: "string", enum: ["system", "local"] },
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
  ProviderStatus: {
    type: "object",
    required: ["id", "provider", "status", "authMode"],
    properties: {
      id: { type: "string", description: "Provider requirement ID" },
      provider: { type: "string", description: "Provider ID" },
      description: { type: "string" },
      status: { type: "string", enum: ["connected", "not_connected", "needs_reconnection"] },
      authMode: { type: "string" },
      scopesRequired: { type: "array", items: { type: "string" } },
      scopesGranted: { type: "array", items: { type: "string" } },
      scopesSufficient: { type: "boolean" },
      scopesMissing: { type: "array", items: { type: "string" } },
      source: {
        type: "string",
        enum: ["app_binding", "user_profile"],
        description: "How the connection profile was resolved",
      },
      profileName: {
        type: ["string", "null"],
        description: "Name of the connection profile used",
      },
      profileOwnerName: {
        type: ["string", "null"],
        description: "Name of the owner of the connection profile",
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
  AgentToolRef: {
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
      displayName: { type: "string" },
      description: { type: "string" },
      schemaVersion: { type: "string" },
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
        enum: ["agent", "skill", "tool", "provider"],
      },
      runningRuns: { type: "integer" },
      dependencies: {
        type: "object",
        properties: {
          providers: { type: "object", additionalProperties: { type: "string" } },
          skills: { type: "object", additionalProperties: { type: "string" } },
          tools: { type: "object", additionalProperties: { type: "string" } },
        },
      },
    },
  },
  AgentDetail: {
    type: "object",
    required: ["id", "source"],
    properties: {
      id: { type: "string" },
      displayName: { type: "string" },
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
      lockVersion: {
        type: "integer",
        description: "Optimistic lock version (user agents only)",
      },
      config: {
        type: "object",
        description: "AFPS schema wrapper for agent configuration (set once, reused across runs).",
        properties: {
          schema: { type: "object", description: "Pure JSON Schema 2020-12 object" },
          current: { type: "object", description: "Current configuration values" },
          fileConstraints: { $ref: "#/components/schemas/FileConstraintsMap" },
          uiHints: { $ref: "#/components/schemas/UIHintsMap" },
          propertyOrder: {
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
          fileConstraints: { $ref: "#/components/schemas/FileConstraintsMap" },
          uiHints: { $ref: "#/components/schemas/UIHintsMap" },
          propertyOrder: {
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
          propertyOrder: {
            type: "array",
            items: { type: "string" },
            description: "Presentation order for schema properties",
          },
        },
      },
      dependencies: {
        type: "object",
        properties: {
          providers: { type: "array", items: { $ref: "#/components/schemas/ProviderStatus" } },
          skills: { type: "array", items: { $ref: "#/components/schemas/AgentSkillRef" } },
          tools: { type: "array", items: { $ref: "#/components/schemas/AgentToolRef" } },
        },
      },
      lastRun: {
        type: ["object", "null"],
        description: "Summary of the most recent run (null if never run)",
        properties: {
          id: { type: "string" },
          status: { type: "string" },
          startedAt: { type: "string", format: "date-time" },
          duration: { type: "integer" },
        },
      },
      runningRuns: { type: "integer" },
      versionCount: {
        type: "integer",
        description: "Number of published versions (0 for built-in agents)",
      },
      agentAppProfileId: {
        type: ["string", "null"],
        format: "uuid",
        description: "Admin-configured app connection profile ID (null if none)",
      },
      agentAppProfileName: {
        type: ["string", "null"],
        description: "Display name of the admin-configured app connection profile",
      },
      forkedFrom: { type: ["string", "null"], description: "Source package ID if forked" },
      hasUnarchivedChanges: {
        type: "boolean",
        description: "Whether the active version has changes not yet archived as a version",
      },
      populatedProviders: {
        type: "object",
        additionalProperties: { $ref: "#/components/schemas/ProviderConfig" },
        description: "ProviderConfig keyed by provider ID for the agent's required providers",
      },
      callbackUrl: {
        type: "string",
        description: "OAuth callback URL for provider connections",
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
      artifactSize: { type: "integer", description: "Artifact ZIP size in bytes" },
      yanked: { type: "boolean", description: "Whether this version has been yanked" },
      createdBy: { type: ["string", "null"] },
      createdAt: { type: ["string", "null"], format: "date-time" },
    },
  },
  Run: {
    type: "object",
    required: ["id", "orgId", "applicationId", "status", "versionDirty", "startedAt"],
    properties: {
      id: { type: "string" },
      packageId: {
        type: ["string", "null"],
        description:
          "Source agent ID. NULL when the source agent has been deleted — the run row survives via `runs.package_id ON DELETE SET NULL` (migration 0017). Read `agentScope` / `agentName` for display in that case; re-running is not possible.",
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
      tokenUsage: {
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
      startedAt: { type: "string", format: "date-time" },
      completedAt: { type: "string", format: "date-time" },
      duration: { type: "integer", description: "Duration in milliseconds" },
      connectionProfileId: { type: "string" },
      scheduleId: { type: "string" },
      versionLabel: {
        type: ["string", "null"],
        description: "Version label at run time (e.g. '1.0.0')",
      },
      versionDirty: {
        type: "boolean",
        description: "Whether the draft had unpublished changes at run time",
      },
      proxyLabel: { type: ["string", "null"], description: "Proxy label used at run time" },
      modelLabel: { type: ["string", "null"], description: "Model label used at run time" },
      modelSource: {
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
      configOverride: {
        type: ["object", "null"],
        description:
          "Per-run config delta — the raw object the caller sent in the request body. `config` is the resolved (deep-merged) snapshot; `configOverride` is the raw delta that the dashboard uses to badge 'default vs override'. Null when the run used persisted defaults verbatim.",
        additionalProperties: true,
      },
      userName: {
        type: ["string", "null"],
        description:
          "Display name of the dashboard user who triggered the run (from profiles table)",
      },
      endUserName: {
        type: ["string", "null"],
        description: "Display name of the end-user (name or externalId fallback)",
      },
      apiKeyName: {
        type: ["string", "null"],
        description: "Name of the API key that triggered the run",
      },
      scheduleName: {
        type: ["string", "null"],
        description: "Name of the schedule that triggered the run",
      },
      runnerName: {
        type: ["string", "null"],
        description:
          "Human-friendly label for the runner that triggered the run — CLI host (`os.hostname()`), GitHub Action workflow, or whatever the caller passes via `X-Appstrate-Runner-Name`. Stamped at INSERT and never updated.",
      },
      runnerKind: {
        type: ["string", "null"],
        description:
          "Free-form classifier driving the dashboard icon (`cli`, `github-action`, …). Sourced from `X-Appstrate-Runner-Kind` or inferred from the auth context.",
      },
      agentScope: {
        type: ["string", "null"],
        description:
          "Denormalized agent scope at run creation. Survives rename, delete, or shadow compaction — the global run view falls back to this when the source package is gone.",
      },
      agentName: {
        type: ["string", "null"],
        description: "Denormalized agent name at run creation (see agentScope).",
      },
      packageEphemeral: {
        type: "boolean",
        description:
          "Present on enriched run responses. True when the source package is an inline-run shadow (POST /api/runs/inline).",
      },
      inlineManifest: {
        type: ["object", "null"],
        description:
          "Inline runs only. Snapshot of the manifest submitted at run time. Null once the shadow has been compacted (see INLINE_RUN_LIMITS.retention_days).",
        additionalProperties: true,
      },
      inlinePrompt: {
        type: ["string", "null"],
        description:
          "Inline runs only. Snapshot of the prompt submitted at run time. Null once the shadow has been compacted.",
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
      "connectionProfileId",
      "orgId",
      "cronExpression",
      "createdAt",
      "updatedAt",
    ],
    properties: {
      id: { type: "string" },
      packageId: { type: "string" },
      connectionProfileId: { type: "string", format: "uuid" },
      orgId: { type: "string" },
      name: { type: ["string", "null"] },
      enabled: { type: ["boolean", "null"] },
      cronExpression: { type: "string" },
      timezone: { type: ["string", "null"] },
      input: { type: "object" },
      configOverride: { type: ["object", "null"] },
      modelIdOverride: { type: ["string", "null"] },
      proxyIdOverride: { type: ["string", "null"] },
      versionOverride: { type: ["string", "null"] },
      lastRunAt: { type: ["string", "null"], format: "date-time" },
      nextRunAt: { type: ["string", "null"], format: "date-time" },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
      profileName: { type: ["string", "null"] },
      profileType: { type: ["string", "null"], enum: ["user", "app", null] },
      readiness: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["ready", "degraded", "not_ready"] },
          totalProviders: { type: "integer" },
          connectedProviders: { type: "integer" },
          missingProviders: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
  AvailableProvider: {
    type: "object",
    required: ["uniqueKey", "provider", "status", "authMode"],
    properties: {
      uniqueKey: { type: "string" },
      provider: { type: "string" },
      displayName: { type: "string" },
      logo: { type: "string" },
      status: { type: "string", enum: ["connected", "not_connected", "needs_reconnection"] },
      authMode: { type: "string" },
      connectionId: { type: "string" },
      connectedAt: { type: "string" },
      scopesGranted: { type: "array", items: { type: "string" } },
    },
  },
  ConnectionStatus: {
    type: "object",
    required: ["provider", "status"],
    properties: {
      provider: { type: "string" },
      status: { type: "string", enum: ["connected", "not_connected", "needs_reconnection"] },
      connectionId: { type: "string" },
      connectedAt: { type: "string" },
      scopesGranted: { type: "array", items: { type: "string" } },
    },
  },
  ProviderConfig: {
    type: "object",
    required: ["id", "displayName", "authMode"],
    properties: {
      id: { type: "string" },
      displayName: { type: "string" },
      authMode: providerAuthModeEnum,
      source: { type: "string", enum: ["built-in", "custom"] },
      hasCredentials: {
        type: "boolean",
        description: "Whether admin credentials are currently configured for this provider",
      },
      enabled: {
        type: "boolean",
        description: "Whether this provider is enabled for use in the organization",
      },
      adminCredentialSchema: {
        type: "object",
        description:
          "JSON Schema describing admin credential fields. Undefined means no admin credentials needed.",
      },
      authorizationUrl: { type: "string" },
      tokenUrl: { type: "string" },
      refreshUrl: { type: "string" },
      requestTokenUrl: { type: "string", description: "OAuth1 request token endpoint" },
      accessTokenUrl: { type: "string", description: "OAuth1 access token endpoint" },
      defaultScopes: { type: "array", items: { type: "string" } },
      scopeSeparator: { type: "string" },
      pkceEnabled: { type: "boolean" },
      tokenAuthMethod: { type: "string", enum: ["client_secret_post", "client_secret_basic"] },
      tokenContentType: providerTokenContentTypeProperty,
      authorizationParams: { type: "object" },
      tokenParams: { type: "object" },
      credentialSchema: { type: "object" },
      credentialFieldName: { type: "string" },
      credentialHeaderName: { type: "string" },
      credentialHeaderPrefix: { type: "string" },
      credentialTransform: providerCredentialTransformProperty,
      availableScopes: providerAvailableScopesProperty,
      authorizedUris: { type: "array", items: { type: "string" } },
      allowAllUris: { type: "boolean" },
      iconUrl: { type: "string" },
      categories: { type: "array", items: { type: "string" } },
      docsUrl: { type: "string" },
      usedByAgents: { type: "integer" },
    },
  },
  ProviderConfigInput: {
    type: "object",
    required: ["id", "displayName", "authMode"],
    properties: {
      id: { type: "string", minLength: 1 },
      displayName: { type: "string", minLength: 1 },
      ...providerInputSharedProperties,
    },
  },
  ProviderConfigUpdate: {
    type: "object",
    required: ["displayName", "authMode"],
    properties: {
      displayName: { type: "string", minLength: 1 },
      ...providerInputSharedProperties,
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
      createdByName: { type: "string" },
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
      createdBy: { type: ["string", "null"] },
      createdByName: { type: "string" },
      usedByAgents: { type: "integer" },
      version: { type: ["string", "null"], description: "Manifest version (semver)" },
      autoInstalled: { type: "boolean" },
      forkedFrom: { type: ["string", "null"], description: "Source package ID if forked" },
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
      source: { type: "string", enum: ["system", "local"] },
      createdBy: { type: ["string", "null"] },
      createdByName: { type: "string" },
      usedByAgents: { type: "integer" },
      autoInstalled: { type: "boolean" },
      lockVersion: { type: "integer", description: "Optimistic lock version" },
      version: { type: ["string", "null"], description: "Manifest version (semver)" },
      manifest: { type: "object", description: "Full manifest object" },
      manifestName: {
        type: ["string", "null"],
        description: "Manifest name (@scope/name) — may differ from package ID",
      },
      versionCount: {
        type: "integer",
        description: "Number of published versions",
      },
      hasUnarchivedChanges: {
        type: "boolean",
        description: "Whether the active version has changes not yet archived as a version",
      },
      forkedFrom: { type: ["string", "null"], description: "Source package ID if forked" },
      agents: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            displayName: { type: "string" },
          },
        },
      },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
  },
  OrgModelProviderKey: {
    type: "object",
    required: ["id", "label", "apiShape", "baseUrl", "source", "createdAt", "updatedAt"],
    properties: {
      id: { type: "string" },
      label: { type: "string" },
      apiShape: { type: "string" },
      baseUrl: { type: "string" },
      source: { type: "string", enum: ["built-in", "custom"] },
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
      "providerKeyId",
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
      providerKeyId: {
        type: "string",
        description: "Provider key ID for API key credentials",
      },
      providerKeyLabel: { type: ["string", "null"], description: "Provider key label for display" },
      keyKind: {
        type: ["string", "null"],
        enum: ["oauth", "api-key", null],
        description:
          "Anthropic-only: shape of the upstream credential. Drives the CLI's pi-ai placeholder so OAuth-gated body reshaping (Claude-Code system prompt + tool renaming) happens locally before the proxy ever sees the request. null for non-Anthropic protocols.",
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
    allOf: [{ $ref: "https://afps.appstrate.dev/packages/schema/v1/agent.schema.json" }],
  },
  SkillManifest: {
    description: "AFPS Skill manifest. See https://afps.appstrate.dev for field reference.",
    $ref: "https://afps.appstrate.dev/packages/schema/v1/skill.schema.json",
  },
  ToolManifest: {
    description: "AFPS Tool manifest. See https://afps.appstrate.dev for field reference.",
    $ref: "https://afps.appstrate.dev/packages/schema/v1/tool.schema.json",
  },
  ProviderManifest: {
    description: "AFPS Provider manifest. See https://afps.appstrate.dev for field reference.",
    $ref: "https://afps.appstrate.dev/packages/schema/v1/provider.schema.json",
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
        maxSize: {
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
      "`installedIn` array listing the caller-org applications where the package " +
      "is currently installed (empty array = not installed in any of the caller's apps).",
    items: {
      type: "object",
      required: ["id", "type", "source", "name", "description", "installedIn"],
      properties: {
        id: { type: "string", description: "Package id (`pkg_…`)." },
        type: { type: "string", enum: ["agent", "skill", "tool", "provider"] },
        source: {
          type: "string",
          description:
            "Package origin (e.g. `org` for org-owned packages, `system` for built-in system packages).",
        },
        name: {
          type: "string",
          description:
            "Display name from the package draft manifest (`displayName`); falls back to the package id.",
        },
        description: {
          type: "string",
          description:
            "Description from the package draft manifest; empty string when not provided.",
        },
        installedIn: {
          type: "array",
          description:
            "Application ids (`app_…`) belonging to the caller's org where this package is installed.",
          items: { type: "string" },
        },
      },
    },
  },
} as const;
