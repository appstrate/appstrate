import { describe, test, expect, mock, beforeEach } from "bun:test";

// --- Mocks ---

const noop = () => {};

mock.module("../../lib/logger.ts", () => ({
  logger: { debug: noop, info: noop, warn: noop, error: noop },
}));

// --- Drizzle mock (queue-based) ---

let selectQueue: unknown[][] = [];

function chainable(result: unknown[]) {
  const obj = {
    from: () => obj,
    where: () => obj,
    limit: () => obj,
    orderBy: () => obj,
    then: (resolve: (v: unknown) => void) => resolve(result),
  };
  return obj;
}

const dbOps = {
  select: () => {
    const result = selectQueue.shift() ?? [];
    return chainable(result);
  },
  insert: () => ({
    values: () => Promise.resolve(),
  }),
  update: () => ({
    set: () => ({
      where: () => Promise.resolve(),
    }),
  }),
  execute: () => Promise.resolve(),
};

mock.module("../../lib/db.ts", () => ({
  db: {
    ...dbOps,
    transaction: async (fn: (tx: typeof dbOps) => Promise<void>) => fn(dbOps),
  },
}));

mock.module("@appstrate/env", () => ({
  getEnv: () => ({ REGISTRY_URL: "http://test-registry" }),
}));

// --- Registry client mock ---

const registryPackages = new Map<string, Record<string, unknown>>();

mock.module("@appstrate/registry-client", () => ({
  RegistryClient: class {
    async getPackage(scope: string, name: string) {
      const key = `${scope}/${name}`;
      return registryPackages.get(key) ?? null;
    }
    async downloadArtifact() {
      return {
        data: new Uint8Array([1, 2, 3]),
        integrity: "sha256-abc123",
        verified: true,
      };
    }
  },
}));

// --- ZIP mock ---

let zipQueue: Record<string, unknown>[] = [];

mock.module("@appstrate/core/zip", () => ({
  parsePackageZip: () => {
    const parsed = zipQueue.shift();
    if (!parsed) throw new Error("zipQueue empty — test setup error");
    return parsed;
  },
  PackageZipError: class extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
  zipArtifact: () => new Uint8Array(),
  unzipArtifact: () => ({ files: {} }),
}));

mock.module("@appstrate/core/integrity", () => ({
  computeIntegrity: () => "sha256-abc123",
}));

mock.module("@appstrate/core/validation", () => ({
  extractSkillMeta: () => ({ name: "test", description: "test" }),
}));

mock.module("@appstrate/db/storage", () => ({
  ensureBucket: async () => {},
  uploadFile: async () => {},
  downloadFile: async () => null,
  deleteFile: async () => {},
}));

mock.module("../builtin-packages.ts", () => ({
  getBuiltInSkills: () => new Map(),
  getBuiltInExtensions: () => new Map(),
  isBuiltInSkill: () => false,
  isBuiltInExtension: () => false,
  resolveBuiltInSkill: () => undefined,
  resolveBuiltInExtension: () => undefined,
  BUILTIN_SCOPE: "appstrate",
}));

let latestVersionIdResult: number | null = null;

mock.module("../package-versions.ts", () => ({
  createVersionAndUpload: async () => {},
  getLatestVersionId: async () => latestVersionIdResult,
}));

// --- DB schema stubs ---

mock.module("@appstrate/db/schema", () => ({
  packages: {
    id: "id",
    orgId: "org_id",
    type: "type",
    source: "source",
    name: "name",
    manifest: "manifest",
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
    integrity: "integrity",
    version: "version",
  },
  packageDistTags: {
    packageId: "package_id",
    tag: "tag",
    versionId: "version_id",
  },
}));

// --- Service mocks ---

const registryClientInstance = {
  getPackage: async (scope: string, name: string) => {
    const key = `${scope}/${name}`;
    return registryPackages.get(key) ?? null;
  },
};

mock.module("../registry-provider.ts", () => ({
  getRegistryClient: () => registryClientInstance,
  isRegistryConfigured: () => true,
  getRegistryDiscovery: () => null,
}));

mock.module("../post-install-package.ts", () => ({
  postInstallPackage: async () => {},
}));

// --- Import after mocks ---

const { getMarketplacePackageWithInstallStatus, installFromMarketplace, checkRegistryUpdates } =
  await import("../marketplace.ts");

// --- Helpers ---

function makeRegistryPkg(
  scope: string,
  name: string,
  versions: { id: number; version: string; integrity: string }[],
) {
  return {
    scope,
    name,
    type: "skill",
    description: `${name} package`,
    versions,
    distTags: [{ tag: "latest", versionId: versions[versions.length - 1]!.id }],
    keywords: [],
    downloads: 0,
  };
}

// --- Tests ---

beforeEach(() => {
  selectQueue = [];
  registryPackages.clear();
  zipQueue = [];
  latestVersionIdResult = null;
});

// Query flow for getMarketplacePackageWithInstallStatus:
//   1. getMarketplacePackage → registry mock (no DB)
//   2. SELECT installed check (packages WHERE id+orgId)
//   3. getLocalVersionIntegrities: SELECT version, integrity FROM packageVersions WHERE packageId
//   4. (if match) resolveInstalledVersion: getLatestVersionId → latestVersionIdResult, then SELECT version

describe("getMarketplacePackageWithInstallStatus — integrity check", () => {
  test("matching (version, integrity) → installedVersion set, integrityConflict false", async () => {
    registryPackages.set(
      "@acme/foo",
      makeRegistryPkg("@acme", "foo", [{ id: 1, version: "1.0.0", integrity: "sha256-match" }]),
    );

    latestVersionIdResult = 42;

    selectQueue = [
      [{ id: "@acme/foo" }], // installed check
      [{ version: "1.0.0", integrity: "sha256-match" }], // getLocalVersionIntegrities
      [{ version: "1.0.0" }], // resolveInstalledVersion SELECT
    ];

    const result = await getMarketplacePackageWithInstallStatus("@acme", "foo", "org-1");

    expect(result).not.toBeNull();
    expect(result!.installedVersion).toBe("1.0.0");
    expect(result!.integrityConflict).toBe(false);
  });

  test("same version but different integrity → integrityConflict true", async () => {
    registryPackages.set(
      "@acme/foo",
      makeRegistryPkg("@acme", "foo", [{ id: 1, version: "1.0.0", integrity: "sha256-registry" }]),
    );

    selectQueue = [
      [{ id: "@acme/foo" }], // installed check
      [{ version: "1.0.0", integrity: "sha256-local-different" }], // getLocalVersionIntegrities
    ];

    const result = await getMarketplacePackageWithInstallStatus("@acme", "foo", "org-1");

    expect(result).not.toBeNull();
    expect(result!.installedVersion).toBeNull();
    expect(result!.integrityConflict).toBe(true);
  });

  test("no local package → installable, integrityConflict false", async () => {
    registryPackages.set(
      "@acme/foo",
      makeRegistryPkg("@acme", "foo", [{ id: 1, version: "1.0.0", integrity: "sha256-abc" }]),
    );

    selectQueue = [
      [], // installed check → not found
    ];

    const result = await getMarketplacePackageWithInstallStatus("@acme", "foo", "org-1");

    expect(result).not.toBeNull();
    expect(result!.installedVersion).toBeNull();
    expect(result!.integrityConflict).toBe(false);
  });

  test("local has newer unpublished version but v1.0.0 matches registry → no conflict", async () => {
    registryPackages.set(
      "@acme/foo",
      makeRegistryPkg("@acme", "foo", [{ id: 1, version: "1.0.0", integrity: "sha256-v1" }]),
    );

    latestVersionIdResult = 99;

    selectQueue = [
      [{ id: "@acme/foo" }], // installed check
      // getLocalVersionIntegrities → returns ALL local versions
      [
        { version: "1.0.0", integrity: "sha256-v1" },
        { version: "1.1.0", integrity: "sha256-local-new" },
      ],
      [{ version: "1.1.0" }], // resolveInstalledVersion SELECT (latest is 1.1.0)
    ];

    const result = await getMarketplacePackageWithInstallStatus("@acme", "foo", "org-1");

    expect(result).not.toBeNull();
    expect(result!.installedVersion).toBe("1.1.0");
    expect(result!.integrityConflict).toBe(false);
  });

  test("same integrity but different version → conflict (no false positive)", async () => {
    registryPackages.set(
      "@acme/foo",
      makeRegistryPkg("@acme", "foo", [{ id: 1, version: "1.0.1", integrity: "sha256-same" }]),
    );

    selectQueue = [
      [{ id: "@acme/foo" }], // installed check
      // Only local v1.0.0 with same integrity but different version
      [{ version: "1.0.0", integrity: "sha256-same" }],
    ];

    const result = await getMarketplacePackageWithInstallStatus("@acme", "foo", "org-1");

    expect(result).not.toBeNull();
    expect(result!.installedVersion).toBeNull();
    expect(result!.integrityConflict).toBe(true);
  });
});

// Query flow for installFromMarketplace conflict guard:
//   1. SELECT existing check (packages WHERE id+orgId)
//   2. getLocalVersionIntegrities: SELECT version, integrity FROM packageVersions WHERE packageId
//   3. registry getPackage (mock, no DB)
//   4. (if no conflict) Phase A collect → Phase B commit ...

describe("installFromMarketplace — integrity conflict guard", () => {
  test("install blocked when no local (version, integrity) matches registry", async () => {
    registryPackages.set(
      "@acme/foo",
      makeRegistryPkg("@acme", "foo", [{ id: 1, version: "1.0.0", integrity: "sha256-registry" }]),
    );

    selectQueue = [
      [{ id: "@acme/foo" }], // existing check
      [{ version: "1.0.0", integrity: "sha256-local-different" }], // getLocalVersionIntegrities
    ];

    await expect(
      installFromMarketplace("@acme", "foo", undefined, "org-1", "user-1", undefined),
    ).rejects.toThrow("Cannot install");
  });

  test("install allowed when a local (version, integrity) matches registry", async () => {
    registryPackages.set(
      "@acme/foo",
      makeRegistryPkg("@acme", "foo", [{ id: 1, version: "1.0.0", integrity: "sha256-abc123" }]),
    );

    latestVersionIdResult = 42;
    zipQueue.push({
      manifest: { displayName: "Foo" },
      content: "content",
      files: {},
      type: "skill",
    });

    selectQueue = [
      [{ id: "@acme/foo" }], // conflict guard existing check
      [{ version: "1.0.0", integrity: "sha256-abc123" }], // getLocalVersionIntegrities → matches
      [{ id: "@acme/foo" }], // commit phase existing check → UPDATE
    ];

    const result = await installFromMarketplace(
      "@acme",
      "foo",
      undefined,
      "org-1",
      "user-1",
      undefined,
    );

    expect(result.packageId).toBe("@acme/foo");
  });

  test("install allowed when local has extra unpublished version but one matches", async () => {
    registryPackages.set(
      "@acme/foo",
      makeRegistryPkg("@acme", "foo", [
        { id: 1, version: "1.0.0", integrity: "sha256-abc123" },
        { id: 2, version: "1.1.0", integrity: "sha256-v11" },
      ]),
    );

    latestVersionIdResult = 42;
    zipQueue.push({
      manifest: { displayName: "Foo" },
      content: "content",
      files: {},
      type: "skill",
    });

    selectQueue = [
      [{ id: "@acme/foo" }], // conflict guard existing check
      // Local has v1.0.0 (matches registry) + v1.2.0 (local only)
      [
        { version: "1.0.0", integrity: "sha256-abc123" },
        { version: "1.2.0", integrity: "sha256-local-only" },
      ],
      [{ id: "@acme/foo" }], // commit phase existing check → UPDATE
    ];

    const result = await installFromMarketplace(
      "@acme",
      "foo",
      undefined,
      "org-1",
      "user-1",
      undefined,
    );

    expect(result.packageId).toBe("@acme/foo");
  });
});

// Query flow for checkRegistryUpdates:
//   1. getInstalledRegistryPackages: SELECT FROM packages WHERE orgId
//   2. per package: registry getPackage (mock)
//   3. getLocalVersionIntegrities: SELECT version, integrity FROM packageVersions WHERE packageId
//   4. (if match) resolveInstalledVersion + checkUpdateAvailable

describe("checkRegistryUpdates — integrity filter", () => {
  test("update skipped when no local (version, integrity) matches registry", async () => {
    latestVersionIdResult = 42;

    selectQueue = [
      [
        {
          id: "@acme/foo",
          type: "skill",
          manifest: { version: "1.0.0" },
          updatedAt: new Date(),
        },
      ],
      // getLocalVersionIntegrities — local v1.0.0 has different integrity
      [{ version: "1.0.0", integrity: "sha256-local-only" }],
    ];

    registryPackages.set(
      "@acme/foo",
      makeRegistryPkg("@acme", "foo", [
        { id: 1, version: "1.0.0", integrity: "sha256-registry" },
        { id: 2, version: "1.1.0", integrity: "sha256-registry-v2" },
      ]),
    );

    const results = await checkRegistryUpdates("org-1");

    expect(results).toHaveLength(0);
  });

  test("update proposed when local (version, integrity) matches a registry version", async () => {
    latestVersionIdResult = 42;

    selectQueue = [
      // getInstalledRegistryPackages
      [
        {
          id: "@acme/foo",
          type: "skill",
          manifest: { version: "1.0.0" },
          updatedAt: new Date(),
        },
      ],
      // getLocalVersionIntegrities — v1.0.0 matches registry
      [{ version: "1.0.0", integrity: "sha256-v1" }],
      // resolveInstalledVersion: getLatestVersionId → 42, then SELECT version
      [{ version: "1.0.0" }],
    ];

    const pkg = makeRegistryPkg("@acme", "foo", [
      { id: 1, version: "1.0.0", integrity: "sha256-v1" },
      { id: 2, version: "1.1.0", integrity: "sha256-v2" },
    ]);
    pkg.distTags = [{ tag: "latest", versionId: 2 }];
    registryPackages.set("@acme/foo", pkg);

    const results = await checkRegistryUpdates("org-1");

    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe("@acme/foo");
    expect(results[0]!.updateAvailable).toBe(true);
  });

  test("update proposed when local has extra unpublished version but v1.0.0 matches", async () => {
    latestVersionIdResult = 99;

    selectQueue = [
      [
        {
          id: "@acme/foo",
          type: "skill",
          manifest: { version: "1.0.0" },
          updatedAt: new Date(),
        },
      ],
      // getLocalVersionIntegrities — v1.0.0 matches, v1.2.0 is local-only
      [
        { version: "1.0.0", integrity: "sha256-v1" },
        { version: "1.2.0", integrity: "sha256-local-new" },
      ],
      // resolveInstalledVersion
      [{ version: "1.2.0" }],
    ];

    const pkg = makeRegistryPkg("@acme", "foo", [
      { id: 1, version: "1.0.0", integrity: "sha256-v1" },
      { id: 2, version: "1.1.0", integrity: "sha256-v11" },
    ]);
    pkg.distTags = [{ tag: "latest", versionId: 2 }];
    registryPackages.set("@acme/foo", pkg);

    const results = await checkRegistryUpdates("org-1");

    // Should still show up — package is from registry (v1.0.0 matches)
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe("@acme/foo");
  });
});

// Query flow for localVersionAhead in getMarketplacePackageWithInstallStatus:
//   Same as integrity check — localVersionAhead is computed from the same localVersions query.
//   No additional DB query is made.

describe("getMarketplacePackageWithInstallStatus — localVersionAhead", () => {
  test("local version 1.1.0 > registry 1.0.0 → localVersionAhead: '1.1.0'", async () => {
    registryPackages.set(
      "@acme/foo",
      makeRegistryPkg("@acme", "foo", [{ id: 1, version: "1.0.0", integrity: "sha256-v1" }]),
    );

    latestVersionIdResult = 99;

    selectQueue = [
      [{ id: "@acme/foo" }], // installed check
      [
        { version: "1.0.0", integrity: "sha256-v1" },
        { version: "1.1.0", integrity: "sha256-local-new" },
      ], // getLocalVersionIntegrities
      [{ version: "1.1.0" }], // resolveInstalledVersion SELECT
    ];

    const result = await getMarketplacePackageWithInstallStatus("@acme", "foo", "org-1");

    expect(result).not.toBeNull();
    expect(result!.installedVersion).toBe("1.1.0");
    expect(result!.integrityConflict).toBe(false);
    expect(result!.localVersionAhead).toBe("1.1.0");
  });

  test("local version = registry latest → localVersionAhead: null", async () => {
    registryPackages.set(
      "@acme/foo",
      makeRegistryPkg("@acme", "foo", [{ id: 1, version: "1.0.0", integrity: "sha256-v1" }]),
    );

    latestVersionIdResult = 42;

    selectQueue = [
      [{ id: "@acme/foo" }], // installed check
      [{ version: "1.0.0", integrity: "sha256-v1" }], // getLocalVersionIntegrities
      [{ version: "1.0.0" }], // resolveInstalledVersion SELECT
    ];

    const result = await getMarketplacePackageWithInstallStatus("@acme", "foo", "org-1");

    expect(result).not.toBeNull();
    expect(result!.installedVersion).toBe("1.0.0");
    expect(result!.integrityConflict).toBe(false);
    expect(result!.localVersionAhead).toBeNull();
  });

  test("conflict + local version > registry → integrityConflict: true + localVersionAhead set", async () => {
    registryPackages.set(
      "@acme/foo",
      makeRegistryPkg("@acme", "foo", [{ id: 1, version: "1.0.0", integrity: "sha256-registry" }]),
    );

    selectQueue = [
      [{ id: "@acme/foo" }], // installed check
      [{ version: "2.0.0", integrity: "sha256-local-different" }], // getLocalVersionIntegrities — no match
    ];

    const result = await getMarketplacePackageWithInstallStatus("@acme", "foo", "org-1");

    expect(result).not.toBeNull();
    expect(result!.installedVersion).toBeNull();
    expect(result!.integrityConflict).toBe(true);
    expect(result!.localVersionAhead).toBe("2.0.0");
  });

  test("conflict + local version ≤ registry → localVersionAhead: null", async () => {
    registryPackages.set(
      "@acme/foo",
      makeRegistryPkg("@acme", "foo", [{ id: 1, version: "2.0.0", integrity: "sha256-registry" }]),
    );

    selectQueue = [
      [{ id: "@acme/foo" }], // installed check
      [{ version: "1.0.0", integrity: "sha256-local-different" }], // getLocalVersionIntegrities — no match
    ];

    const result = await getMarketplacePackageWithInstallStatus("@acme", "foo", "org-1");

    expect(result).not.toBeNull();
    expect(result!.installedVersion).toBeNull();
    expect(result!.integrityConflict).toBe(true);
    expect(result!.localVersionAhead).toBeNull();
  });
});
