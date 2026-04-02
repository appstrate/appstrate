// SPDX-License-Identifier: Apache-2.0

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
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      email: { type: "string" },
    },
  },
  WebhookObject: {
    type: "object",
    description: "Webhook configuration object",
    properties: {
      id: { type: "string", description: "Webhook ID (wh_ prefix)" },
      object: { type: "string", enum: ["webhook"] },
      scope: {
        type: "string",
        enum: ["organization", "application"],
        description:
          "Webhook scope. 'organization' fires for all executions; 'application' fires only for executions via the linked application's API key",
      },
      applicationId: {
        type: ["string", "null"],
        description:
          "Application ID (app_ prefix). Required when scope is 'application', null otherwise",
      },
      url: { type: "string", format: "uri" },
      events: { type: "array", items: { type: "string" } },
      packageId: { type: ["string", "null"] },
      payloadMode: { type: "string", enum: ["full", "summary"] },
      active: { type: "boolean" },
      createdAt: { type: "string", format: "date-time" },
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
    },
  },
  ProfileBatchItem: {
    type: "object",
    properties: {
      id: { type: "string" },
      displayName: { type: "string" },
    },
  },
  Organization: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      slug: { type: "string" },
      role: { type: "string", enum: ["owner", "admin", "member"] },
    },
  },
  OrgMember: {
    type: "object",
    properties: {
      userId: { type: "string" },
      displayName: { type: "string" },
      email: { type: "string" },
      role: { type: "string", enum: ["owner", "admin", "member"] },
      joinedAt: { type: "string", format: "date-time" },
    },
  },
  OrgInvitationInfo: {
    type: "object",
    properties: {
      id: { type: "string" },
      email: { type: "string" },
      role: { type: "string", enum: ["owner", "admin", "member"] },
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
        enum: ["org_binding", "user_profile"],
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
  FlowSkillRef: {
    type: "object",
    properties: {
      id: { type: "string" },
      version: { type: "string" },
      name: { type: "string" },
      description: { type: "string" },
    },
  },
  FlowToolRef: {
    type: "object",
    properties: {
      id: { type: "string" },
      version: { type: "string" },
      name: { type: "string" },
      description: { type: "string" },
    },
  },
  FlowListItem: {
    type: "object",
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
        enum: ["flow", "skill", "tool", "provider"],
      },
      runningExecutions: { type: "integer" },
      dependencies: {
        type: "object",
        properties: {
          providers: { type: "array", items: { type: "string" } },
          skills: { type: "object", additionalProperties: { type: "string" } },
          tools: { type: "object", additionalProperties: { type: "string" } },
        },
      },
    },
  },
  FlowDetail: {
    type: "object",
    properties: {
      id: { type: "string" },
      displayName: { type: "string" },
      description: { type: "string" },
      source: { type: "string", enum: ["system", "local"] },
      scope: { type: ["string", "null"], description: "Scope from manifest name" },
      version: { type: ["string", "null"], description: "Version from manifest" },
      manifest: {
        allOf: [{ $ref: "#/components/schemas/FlowManifest" }],
        description: "Full manifest object (user flows only)",
      },
      prompt: { type: "string", description: "Agent prompt markdown (user flows only)" },
      updatedAt: {
        type: "string",
        format: "date-time",
        description: "Last updated timestamp (user flows only)",
      },
      lockVersion: {
        type: "integer",
        description: "Optimistic lock version (user flows only)",
      },
      config: {
        type: "object",
        description: "AFPS schema wrapper for flow configuration (set once, reused across runs).",
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
        description: "AFPS schema wrapper for per-execution input.",
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
        description: "AFPS schema wrapper for per-execution output.",
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
          skills: { type: "array", items: { $ref: "#/components/schemas/FlowSkillRef" } },
          tools: { type: "array", items: { $ref: "#/components/schemas/FlowToolRef" } },
        },
      },
      lastExecution: {
        type: ["object", "null"],
        description: "Summary of the most recent execution (null if never executed)",
        properties: {
          id: { type: "string" },
          status: { type: "string" },
          startedAt: { type: "string", format: "date-time" },
          duration: { type: "integer" },
        },
      },
      runningExecutions: { type: "integer" },
      versionCount: {
        type: "integer",
        description: "Number of published versions (0 for built-in flows)",
      },
      flowOrgProfileId: {
        type: ["string", "null"],
        format: "uuid",
        description: "Admin-configured org connection profile ID (null if none)",
      },
      flowOrgProfileName: {
        type: ["string", "null"],
        description: "Display name of the admin-configured org connection profile",
      },
      forkedFrom: { type: ["string", "null"], description: "Source package ID if forked" },
      hasUnpublishedChanges: {
        type: "boolean",
        description: "Whether the flow has local changes not yet published as a version",
      },
      populatedProviders: {
        type: "object",
        additionalProperties: { $ref: "#/components/schemas/ProviderConfig" },
        description: "ProviderConfig keyed by provider ID for the flow's required providers",
      },
      callbackUrl: {
        type: "string",
        description: "OAuth callback URL for provider connections",
      },
    },
  },
  FlowVersion: {
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
  Execution: {
    type: "object",
    properties: {
      id: { type: "string" },
      packageId: { type: "string" },
      userId: { type: "string" },
      orgId: { type: "string" },
      status: {
        type: "string",
        enum: ["pending", "running", "success", "failed", "timeout", "cancelled"],
      },
      input: { type: "object" },
      result: { type: "object" },
      state: { type: "object" },
      error: { type: "string" },
      tokensUsed: { type: "integer" },
      tokenUsage: { type: "object" },
      startedAt: { type: "string", format: "date-time" },
      completedAt: { type: "string", format: "date-time" },
      duration: { type: "integer", description: "Duration in milliseconds" },
      connectionProfileId: { type: "string" },
      scheduleId: { type: "string" },
      packageVersionId: { type: "integer" },
      proxyLabel: { type: ["string", "null"], description: "Proxy label used at execution time" },
      modelLabel: { type: ["string", "null"], description: "Model label used at execution time" },
      cost: { type: ["number", "null"], description: "Execution cost in dollars" },
      endUserId: {
        type: ["string", "null"],
        description: "End-user ID (eu_ prefix) if executed on behalf of an end-user",
      },
      applicationId: {
        type: ["string", "null"],
        description: "Application ID (app_ prefix) that owns this execution",
      },
    },
  },
  ExecutionLog: {
    type: "object",
    properties: {
      id: { type: "integer" },
      executionId: { type: "string" },
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
      lastRunAt: { type: ["string", "null"], format: "date-time" },
      nextRunAt: { type: ["string", "null"], format: "date-time" },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
      profileName: { type: ["string", "null"] },
      profileType: { type: ["string", "null"], enum: ["user", "org", null] },
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
    properties: {
      uniqueKey: { type: "string" },
      provider: { type: "string" },
      displayName: { type: "string" },
      logo: { type: "string" },
      status: { type: "string", enum: ["connected", "not_connected", "needs_reconnection"] },
      authMode: { type: "string" },
      connectionId: { type: "string" },
      connectedAt: { type: "string" },
    },
  },
  ConnectionStatus: {
    type: "object",
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
    properties: {
      id: { type: "string" },
      displayName: { type: "string" },
      authMode: {
        type: "string",
        enum: ["oauth2", "oauth1", "api_key", "basic", "custom"],
      },
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
      authorizationParams: { type: "object" },
      tokenParams: { type: "object" },
      credentialSchema: { type: "object" },
      credentialFieldName: { type: "string" },
      credentialHeaderName: { type: "string" },
      credentialHeaderPrefix: { type: "string" },
      availableScopes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            value: { type: "string" },
            label: { type: "string" },
          },
        },
      },
      authorizedUris: { type: "array", items: { type: "string" } },
      allowAllUris: { type: "boolean" },
      iconUrl: { type: "string" },
      categories: { type: "array", items: { type: "string" } },
      docsUrl: { type: "string" },
      usedByFlows: { type: "integer" },
    },
  },
  ProviderConfigInput: {
    type: "object",
    required: ["id", "displayName", "authMode"],
    properties: {
      id: { type: "string", pattern: "^[a-z0-9][a-z0-9-]*$" },
      displayName: { type: "string" },
      authMode: {
        type: "string",
        enum: ["oauth2", "oauth1", "api_key", "basic", "custom"],
      },
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
      authorizationParams: { type: "object" },
      tokenParams: { type: "object" },
      credentialSchema: { type: "object" },
      credentialFieldName: { type: "string" },
      credentialHeaderName: { type: "string" },
      credentialHeaderPrefix: { type: "string" },
      availableScopes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            value: { type: "string" },
            label: { type: "string" },
          },
        },
      },
      iconUrl: { type: "string" },
      categories: { type: "array", items: { type: "string" } },
      docsUrl: { type: "string" },
      authorizedUris: { type: "array", items: { type: "string" } },
      allowAllUris: { type: "boolean" },
    },
  },
  ApiKeyInfo: {
    type: "object",
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
    properties: {
      id: { type: "string" },
      name: { type: ["string", "null"] },
      description: { type: ["string", "null"] },
      source: { type: "string", enum: ["system", "local"] },
      createdBy: { type: ["string", "null"] },
      createdByName: { type: "string" },
      usedByFlows: { type: "integer" },
      version: { type: ["string", "null"], description: "Manifest version (semver)" },
      autoInstalled: { type: "boolean" },
      forkedFrom: { type: ["string", "null"], description: "Source package ID if forked" },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
  },
  OrgPackageItemDetail: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: ["string", "null"] },
      description: { type: ["string", "null"] },
      content: { type: "string", description: "Package item content" },
      source: { type: "string", enum: ["system", "local"] },
      createdBy: { type: ["string", "null"] },
      createdByName: { type: "string" },
      usedByFlows: { type: "integer" },
      autoInstalled: { type: "boolean" },
      lockVersion: { type: "integer", description: "Optimistic lock version" },
      version: { type: ["string", "null"], description: "Manifest version (semver)" },
      manifest: { type: "object", description: "Full manifest object" },
      manifestName: {
        type: ["string", "null"],
        description: "Manifest name (@scope/name) — may differ from package ID",
      },
      forkedFrom: { type: ["string", "null"], description: "Source package ID if forked" },
      flows: {
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
  FlowMemory: {
    type: "object",
    properties: {
      id: { type: "integer" },
      content: { type: "string" },
      executionId: { type: ["string", "null"] },
      createdAt: { type: ["string", "null"], format: "date-time" },
    },
  },
  OrgProviderKey: {
    type: "object",
    properties: {
      id: { type: "string" },
      label: { type: "string" },
      api: { type: "string" },
      baseUrl: { type: "string" },
      source: { type: "string", enum: ["built-in", "custom"] },
      createdBy: { type: ["string", "null"] },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
  },
  OrgModel: {
    type: "object",
    properties: {
      id: { type: "string" },
      label: { type: "string" },
      api: { type: "string" },
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
    properties: {
      id: { type: "string", description: "Application ID (app_ prefix)" },
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
    properties: {
      id: { type: "string", description: "End-user ID (eu_ prefix)" },
      applicationId: { type: "string", description: "ID of the parent application" },
      name: { type: ["string", "null"], description: "Display name" },
      email: { type: ["string", "null"], format: "email", description: "Email address" },
      externalId: { type: ["string", "null"], description: "External system identifier" },
      metadata: { type: ["object", "null"], description: "Arbitrary key-value metadata" },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
  },
  FlowManifest: {
    description:
      "AFPS Flow manifest extended with Appstrate platform fields. " +
      "Standard fields are defined by the AFPS Flow schema; extension fields use the x- prefix per AFPS §10.",
    allOf: [{ $ref: "https://afps.appstrate.dev/schema/v1/flow.schema.json" }],
  },
  SkillManifest: {
    description: "AFPS Skill manifest. See https://afps.appstrate.dev for field reference.",
    $ref: "https://afps.appstrate.dev/schema/v1/skill.schema.json",
  },
  ToolManifest: {
    description: "AFPS Tool manifest. See https://afps.appstrate.dev for field reference.",
    $ref: "https://afps.appstrate.dev/schema/v1/tool.schema.json",
  },
  ProviderManifest: {
    description: "AFPS Provider manifest. See https://afps.appstrate.dev for field reference.",
    $ref: "https://afps.appstrate.dev/schema/v1/provider.schema.json",
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
} as const;
