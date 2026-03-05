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

/** Tracks values passed to insert/update/delete for assertion in tests. */
export const tracking = {
  insertCalls: [] as Record<string, unknown>[],
  updateCalls: [] as Record<string, unknown>[],
  deleteCalls: [] as Record<string, unknown>[],
};

export function resetQueues() {
  queues.select.length = 0;
  queues.insert.length = 0;
  queues.update.length = 0;
  queues.delete.length = 0;
  tracking.insertCalls.length = 0;
  tracking.updateCalls.length = 0;
  tracking.deleteCalls.length = 0;
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
    execute: () => Promise.resolve(),
  };
}

export const db = makeDbProxy();

/** Comprehensive schema stubs covering all tables used across service tests. */
export const schemaStubs = {
  packages: {
    id: "id",
    orgId: "org_id",
    type: "type",
    name: "name",
    manifest: "manifest",
    lastPublishedVersion: "last_published_version",
    source: "source",
    content: "content",
    autoInstalled: "auto_installed",
    createdBy: "created_by",
    createdAt: "created_at",
    updatedAt: "updated_at",
  },
  packageDependencies: {
    packageId: "package_id",
    dependencyId: "dependency_id",
    orgId: "org_id",
    createdAt: "created_at",
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
};

export const builtinPackagesStub = {
  BUILTIN_SCOPE: "appstrate",
  getBuiltInSkills: () => new Map(),
  getBuiltInExtensions: () => new Map(),
  isBuiltInSkill: () => false,
  isBuiltInExtension: () => false,
  resolveBuiltInSkill: () => undefined,
  resolveBuiltInExtension: () => undefined,
  getBuiltInSkillFiles: async () => null,
  getBuiltInExtensionFile: async () => null,
  initBuiltInPackages: async () => {},
};

export const packageStorageStub = {
  getPackageZip: async () => null,
  uploadPackageZip: async () => {},
  downloadVersionZip: async () => null,
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
  resolveVersion: async () => null,
  getVersionForDownload: async () => null,
  getVersionDetail: async () => null,
  getVersionCount: async () => 0,
  yankVersion: async () => false,
  addDistTag: async () => {},
  removeDistTag: async () => {},
  getMatchingDistTags: async () => [],
  getVersionInfo: async () => null,
  getLatestVersionCreatedAt: async () => null,
  createVersionFromDraft: async () => null,
  createVersionAndUpload: async () => {},
};
