/**
 * Shared DB mock for service tests.
 *
 * bun:test `mock.module` is process-global — the first call wins for a given module path.
 * This shared module ensures all test files use the SAME queue references, so whichever
 * mock.module call wins, the queues are still accessible from every test file.
 */

export const queues = {
  select: [] as unknown[][],
  insert: [] as unknown[][],
  update: [] as unknown[][],
  delete: [] as unknown[][],
};

/** Tracks values passed to insert/update/delete/execute for assertion in tests. */
export const tracking = {
  insertCalls: [] as Record<string, unknown>[],
  updateCalls: [] as Record<string, unknown>[],
  deleteCalls: [] as Record<string, unknown>[],
  executeCalls: [] as unknown[],
};

export function resetQueues() {
  queues.select.length = 0;
  queues.insert.length = 0;
  queues.update.length = 0;
  queues.delete.length = 0;
  tracking.insertCalls.length = 0;
  tracking.updateCalls.length = 0;
  tracking.deleteCalls.length = 0;
  tracking.executeCalls.length = 0;
}

function chainable(result: unknown[]) {
  const obj: Record<string, unknown> = {
    from: () => obj,
    where: () => obj,
    limit: () => obj,
    orderBy: () => obj,
    innerJoin: () => obj,
    returning: () => {
      const r = queues.insert.shift() ?? result;
      return { then: (resolve: (v: unknown) => void) => resolve(r) };
    },
    values: () => obj,
    onConflictDoUpdate: () => obj,
    then: (resolve: (v: unknown) => void) => resolve(result),
  };
  return obj;
}

function makeDbProxy(): Record<string, unknown> {
  return {
    select: () => chainable(queues.select.shift() ?? []),
    insert: () => {
      const obj: Record<string, unknown> = {
        values: (vals: Record<string, unknown>) => {
          if (vals != null) tracking.insertCalls.push(vals);
          return obj;
        },
        returning: () => {
          const r = queues.insert.shift() ?? [];
          return { then: (resolve: (v: unknown) => void) => resolve(r) };
        },
        onConflictDoUpdate: () => obj,
        onConflictDoNothing: () => obj,
        then: (resolve: (v: unknown) => void) => resolve(undefined),
      };
      return obj;
    },
    update: () => {
      const result = queues.update.shift() ?? [];
      const obj: Record<string, unknown> = {
        set: (vals: Record<string, unknown>) => {
          if (vals != null) tracking.updateCalls.push(vals);
          return obj;
        },
        where: () => obj,
        returning: () => ({ then: (resolve: (v: unknown) => void) => resolve(result) }),
        then: (resolve: (v: unknown) => void) => resolve(result),
      };
      return obj;
    },
    delete: (table?: unknown) => {
      tracking.deleteCalls.push({ table });
      const result = queues.delete.shift() ?? [];
      const obj: Record<string, unknown> = {
        where: () => obj,
        then: (resolve: (v: unknown) => void) => resolve(result),
      };
      return obj;
    },
    // transaction() creates a recursive makeDbProxy() — this works because all queues
    // and tracking arrays are module-level singletons, so the inner proxy shares state
    // with the outer one. Tests push into the same queues regardless of nesting depth.
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      return fn(makeDbProxy());
    },
    execute: (query: unknown) => {
      tracking.executeCalls.push(query);
      return Promise.resolve();
    },
  };
}

export const db = makeDbProxy();

/**
 * Comprehensive schema stubs covering ALL tables from @appstrate/db/schema.
 *
 * bun:test `mock.module` is process-global — the first mock.module call for
 * "@appstrate/db/schema" wins across ALL test files in the same process.
 * Every test that mocks the schema MUST spread from this object to ensure
 * all tables are available regardless of which test runs first.
 */
export const schemaStubs = {
  // --- auth.ts ---
  user: {
    id: "id",
    name: "name",
    email: "email",
    emailVerified: "email_verified",
    image: "image",
    source: "source",
    externalId: "external_id",
    metadata: "metadata",
    createdAt: "created_at",
    updatedAt: "updated_at",
  },
  session: {
    id: "id",
    expiresAt: "expires_at",
    token: "token",
    createdAt: "created_at",
    updatedAt: "updated_at",
    ipAddress: "ip_address",
    userAgent: "user_agent",
    userId: "user_id",
  },
  account: {
    id: "id",
    accountId: "account_id",
    providerId: "provider_id",
    userId: "user_id",
    accessToken: "access_token",
    refreshToken: "refresh_token",
    idToken: "id_token",
    accessTokenExpiresAt: "access_token_expires_at",
    refreshTokenExpiresAt: "refresh_token_expires_at",
    scope: "scope",
    password: "password",
    createdAt: "created_at",
    updatedAt: "updated_at",
  },
  verification: {
    id: "id",
    identifier: "identifier",
    value: "value",
    expiresAt: "expires_at",
    createdAt: "created_at",
    updatedAt: "updated_at",
  },

  // --- organizations.ts ---
  organizations: {
    id: "id",
    name: "name",
    slug: "slug",
    settings: "settings",
    createdBy: "created_by",
    createdAt: "created_at",
    updatedAt: "updated_at",
  },
  organizationMembers: {
    orgId: "org_id",
    userId: "user_id",
    role: "role",
    joinedAt: "joined_at",
  },
  orgInvitations: {
    id: "id",
    token: "token",
    email: "email",
    orgId: "org_id",
    role: "role",
    status: "status",
    invitedBy: "invited_by",
    acceptedBy: "accepted_by",
    expiresAt: "expires_at",
    acceptedAt: "accepted_at",
    createdAt: "created_at",
  },
  apiKeys: {
    id: "id",
    orgId: "org_id",
    name: "name",
    keyHash: "key_hash",
    keyPrefix: "key_prefix",
    scopes: "scopes",
    createdBy: "created_by",
    expiresAt: "expires_at",
    lastUsedAt: "last_used_at",
    revokedAt: "revoked_at",
    createdAt: "created_at",
  },
  orgProxies: {
    id: "id",
    orgId: "org_id",
    label: "label",
    urlEncrypted: "url_encrypted",
    enabled: "enabled",
    isDefault: "is_default",
    source: "source",
    createdBy: "created_by",
    createdAt: "created_at",
    updatedAt: "updated_at",
  },
  orgProviderKeys: {
    id: "id",
    orgId: "org_id",
    label: "label",
    api: "api",
    baseUrl: "base_url",
    apiKeyEncrypted: "api_key_encrypted",
    createdBy: "created_by",
    createdAt: "created_at",
    updatedAt: "updated_at",
  },
  orgModels: {
    id: "id",
    orgId: "org_id",
    label: "label",
    api: "api",
    baseUrl: "base_url",
    modelId: "model_id",
    providerKeyId: "provider_key_id",
    input: "input",
    contextWindow: "context_window",
    maxTokens: "max_tokens",
    reasoning: "reasoning",
    cost: "cost",
    enabled: "enabled",
    isDefault: "is_default",
    source: "source",
    createdBy: "created_by",
    createdAt: "created_at",
    updatedAt: "updated_at",
  },

  // --- profiles.ts ---
  profiles: {
    id: "id",
    displayName: "display_name",
    language: "language",
    createdAt: "created_at",
    updatedAt: "updated_at",
  },

  // --- packages.ts ---
  packageConfigs: {
    orgId: "org_id",
    packageId: "package_id",
    config: "config",
    modelId: "model_id",
    proxyId: "proxy_id",
    createdAt: "created_at",
    updatedAt: "updated_at",
  },
  packages: {
    id: "id",
    orgId: "org_id",
    type: "type",
    draftManifest: "draft_manifest",
    source: "source",
    draftContent: "draft_content",
    autoInstalled: "auto_installed",
    createdBy: "created_by",
    createdAt: "created_at",
    updatedAt: "updated_at",
    lockVersion: "lock_version",
  },
  packageVersions: {
    id: "id",
    packageId: "package_id",
    version: "version",
    integrity: "integrity",
    artifactSize: "artifact_size",
    manifest: "manifest",
    yanked: "yanked",
    yankedReason: "yanked_reason",
    createdBy: "created_by",
    createdAt: "created_at",
    orgId: "org_id",
  },
  packageDistTags: {
    packageId: "package_id",
    tag: "tag",
    versionId: "version_id",
    updatedAt: "updated_at",
  },
  packageVersionDependencies: {
    id: "id",
    versionId: "version_id",
    depScope: "dep_scope",
    depName: "dep_name",
    depType: "dep_type",
    versionRange: "version_range",
  },
  packageDependencies: {
    packageId: "package_id",
    dependencyId: "dependency_id",
    orgId: "org_id",
    createdAt: "created_at",
  },

  // --- executions.ts ---
  executions: {
    id: "id",
    packageId: "package_id",
    userId: "user_id",
    orgId: "org_id",
    status: "status",
    input: "input",
    result: "result",
    state: "state",
    error: "error",
    tokensUsed: "tokens_used",
    tokenUsage: "token_usage",
    startedAt: "started_at",
    completedAt: "completed_at",
    duration: "duration",
    connectionProfileId: "connection_profile_id",
    scheduleId: "schedule_id",
    packageVersionId: "package_version_id",
    notifiedAt: "notified_at",
    readAt: "read_at",
    proxyLabel: "proxy_label",
    modelLabel: "model_label",
    cost: "cost",
  },
  executionLogs: {
    id: "id",
    executionId: "execution_id",
    userId: "user_id",
    orgId: "org_id",
    type: "type",
    level: "level",
    event: "event",
    message: "message",
    data: "data",
    createdAt: "created_at",
  },
  packageMemories: {
    id: "id",
    packageId: "package_id",
    orgId: "org_id",
    content: "content",
    executionId: "execution_id",
    createdAt: "created_at",
  },
  packageSchedules: {
    id: "id",
    packageId: "package_id",
    userId: "user_id",
    orgId: "org_id",
    name: "name",
    enabled: "enabled",
    cronExpression: "cron_expression",
    timezone: "timezone",
    input: "input",
    lastRunAt: "last_run_at",
    nextRunAt: "next_run_at",
    createdAt: "created_at",
    updatedAt: "updated_at",
  },
  shareTokens: {
    id: "id",
    token: "token",
    packageId: "package_id",
    orgId: "org_id",
    createdBy: "created_by",
    manifest: "manifest",
    executionId: "execution_id",
    consumedAt: "consumed_at",
    expiresAt: "expires_at",
    createdAt: "created_at",
  },

  // --- connections.ts ---
  connectionProfiles: {
    id: "id",
    userId: "user_id",
    name: "name",
    isDefault: "is_default",
    createdAt: "created_at",
    updatedAt: "updated_at",
  },
  userPackageProfiles: {
    userId: "user_id",
    packageId: "package_id",
    profileId: "profile_id",
    updatedAt: "updated_at",
  },
  flowProviderBindings: {
    packageId: "package_id",
    providerId: "provider_id",
    orgId: "org_id",
    profileId: "profile_id",
    connectedAt: "connected_at",
  },
  providerCredentials: {
    providerId: "provider_id",
    orgId: "org_id",
    credentialsEncrypted: "credentials_encrypted",
    enabled: "enabled",
    updatedAt: "updated_at",
  },
  userProviderConnections: {
    id: "id",
    profileId: "profile_id",
    providerId: "provider_id",
    orgId: "org_id",
    credentialsEncrypted: "credentials_encrypted",
    scopesGranted: "scopes_granted",
    expiresAt: "expires_at",
    createdAt: "created_at",
    updatedAt: "updated_at",
  },
  oauthStates: {
    state: "state",
    orgId: "org_id",
    userId: "user_id",
    profileId: "profile_id",
    providerId: "provider_id",
    codeVerifier: "code_verifier",
    oauthTokenSecret: "oauth_token_secret",
    authMode: "auth_mode",
    scopesRequested: "scopes_requested",
    redirectUri: "redirect_uri",
    createdAt: "created_at",
    expiresAt: "expires_at",
  },

  // --- webhooks.ts ---
  webhooks: {
    id: "id",
    orgId: "org_id",
    url: "url",
    events: "events",
    flowId: "flow_id",
    payloadMode: "payload_mode",
    active: "active",
    secret: "secret",
    previousSecret: "previous_secret",
    previousSecretExpiresAt: "previous_secret_expires_at",
    createdAt: "created_at",
    updatedAt: "updated_at",
  },
  webhookDeliveries: {
    id: "id",
    webhookId: "webhook_id",
    eventId: "event_id",
    eventType: "event_type",
    status: "status",
    statusCode: "status_code",
    latency: "latency",
    attempt: "attempt",
    error: "error",
    createdAt: "created_at",
  },

  // --- enums (string values, needed for Drizzle column references) ---
  orgRoleEnum: "role",
  invitationStatusEnum: "status",
  executionStatusEnum: "status",
  packageTypeEnum: "type",
  packageSourceEnum: "source",
};

export const systemPackagesStub = {
  BUILTIN_SCOPE: "appstrate",
  initSystemPackages: async () => {},
  getSystemPackages: () => new Map(),
  isSystemPackage: () => false,
  getSystemPackageEntry: () => undefined,
  getSystemPackagesByType: () => [],
};

export const packageItemsStorageStub = {
  uploadPackageFiles: async () => "sha256-test-items",
  downloadPackageFiles: async () => null as Record<string, Uint8Array> | null,
  deletePackageFiles: async () => {},
  SYSTEM_STORAGE_NAMESPACE: "_system",
};

export const packageStorageStub = {
  getPackageZip: async () => null,
  uploadPackageZip: async () => {},
  downloadVersionZip: async () => null,
  deleteVersionZip: async () => {},
  unzipAndNormalize: () => ({}),
  ensureStorageBucket: () => {},
  buildMinimalZip: () => Buffer.from([]),
};

class RegistryClientErrorStub extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "RegistryClientError";
    this.status = status;
    this.code = code;
  }
}

export const registryClientStub = {
  RegistryClient: class {},
  RegistryClientError: RegistryClientErrorStub,
};

export const registryProviderStub = {
  getRegistryClient: () => null,
  isRegistryConfigured: () => false,
  getRegistryDiscovery: () => null,
  initRegistryProvider: async () => {},
};

/**
 * Complete stub for ../package-versions.ts.
 *
 * Marketplace tests mock this module but only need 2 functions.
 * We must export ALL functions so that package-versions.test.ts
 * (which imports the real module) doesn't get undefined exports
 * when bun:test's process-global mock.module wins.
 *
 * The `createVersionAndUpload` and `getLatestVersionId` fields
 * are overridable per-test via the exported object.
 */
export const packageVersionsStub = {
  createPackageVersion: async () => null,
  listPackageVersions: async () => [],
  getLatestVersionId: async () => null,
  getLatestVersionWithManifest: async () => null,
  resolveVersion: async () => null,
  resolveVersionManifest: async () => null,
  getVersionForDownload: async () => null,
  getVersionDetail: async () => null,
  getVersionCount: async () => 0,
  yankVersion: async () => false,
  deletePackageVersion: async () => false,
  addDistTag: async () => {},
  removeDistTag: async () => {},
  getMatchingDistTags: async () => [],
  getVersionInfo: async () => null,
  getLatestVersionCreatedAt: async () => null,
  createVersionFromDraft: async () => null,
  createVersionAndUpload: async () => {},
  replaceVersionContent: async () => {},
};
