import { describe, test, expect, mock, beforeEach } from "bun:test";

// --- Mocks ---

const noop = () => {};

mock.module("../../lib/logger.ts", () => ({
  logger: { debug: noop, info: noop, warn: noop, error: noop },
}));

// --- Drizzle mock (queue-based) ---

let selectQueue: unknown[][] = [];
let deletedCount = 0;

function chainable(result: unknown[]) {
  const obj = {
    from: () => obj,
    where: () => obj,
    limit: () => obj,
    orderBy: () => obj,
    innerJoin: () => obj,
    then: (resolve: (v: unknown) => void) => resolve(result),
  };
  return obj;
}

mock.module("../../lib/db.ts", () => ({
  db: {
    select: () => {
      const result = selectQueue.shift() ?? [];
      return chainable(result);
    },
    insert: () => ({
      values: () => ({
        onConflictDoUpdate: () => ({
          returning: () => Promise.resolve([{}]),
        }),
      }),
    }),
    delete: () => ({
      where: () => {
        deletedCount++;
        return Promise.resolve();
      },
    }),
    transaction: async (fn: (tx: unknown) => Promise<void>) => {
      await fn({});
    },
  },
}));

// --- DB schema stubs ---

const col = (name: string) => name;

const schemaExports: Record<string, unknown> = {
  packages: {
    id: col("id"),
    orgId: col("org_id"),
    type: col("type"),
    source: col("source"),
    name: col("name"),
    manifest: col("manifest"),
    content: col("content"),
    autoInstalled: col("auto_installed"),
    createdBy: col("created_by"),
    createdAt: col("created_at"),
    updatedAt: col("updated_at"),
  },
  packageDependencies: {
    packageId: col("package_id"),
    dependencyId: col("dependency_id"),
    orgId: col("org_id"),
    createdAt: col("created_at"),
  },
  packageVersions: {
    id: col("id"),
    packageId: col("package_id"),
    version: col("version"),
    integrity: col("integrity"),
    artifactSize: col("artifact_size"),
    manifest: col("manifest"),
    orgId: col("org_id"),
    yanked: col("yanked"),
    yankedReason: col("yanked_reason"),
    createdBy: col("created_by"),
    createdAt: col("created_at"),
  },
  packageDistTags: {
    packageId: col("package_id"),
    tag: col("tag"),
    versionId: col("version_id"),
    updatedAt: col("updated_at"),
  },
  packageVersionDependencies: {
    id: col("id"),
    versionId: col("version_id"),
    depScope: col("dep_scope"),
    depName: col("dep_name"),
    depType: col("dep_type"),
    versionRange: col("version_range"),
  },
};

mock.module("@appstrate/db/schema", () => schemaExports);

// @appstrate/core/dependencies — NOT mocked (pure function)
// @appstrate/core/naming — NOT mocked (pure functions)

mock.module("../package-storage.ts", () => ({
  getPackageZip: async () => null,
  uploadPackageZip: async () => {},
}));

mock.module("../flow-service.ts", () => ({
  getPackagesDir: () => "/tmp",
}));

mock.module("@appstrate/db/storage", () => ({
  ensureBucket: async () => {},
  uploadFile: async () => {},
  downloadFile: async () => null,
  deleteFile: async () => {},
}));

mock.module("../builtin-library.ts", () => ({
  getBuiltInSkills: () => new Map(),
  getBuiltInExtensions: () => new Map(),
  isBuiltInSkill: () => false,
  isBuiltInExtension: () => false,
  resolveBuiltInSkill: () => undefined,
  resolveBuiltInExtension: () => undefined,
  BUILTIN_SCOPE: "appstrate",
}));

// --- Import after mocks ---

const { deleteOrgItem, listOrgItems, SKILL_CONFIG } = await import("../library.ts");

// --- Tests ---

beforeEach(() => {
  selectQueue = [];
  deletedCount = 0;
});

describe("listOrgItems — filtre autoInstalled", () => {
  test("retourne les items de la DB (filtre autoInstalled appliqué dans la query SQL)", async () => {
    // listOrgItems issues 3 selects:
    // 1. packages (filtered by orgId, type, autoInstalled=false)
    // 2. packageDependencies (for usedByFlows count)
    // 3. flow manifests (for built-in counts)
    const orgItem = {
      id: "my-skill",
      orgId: "org-1",
      name: "my-skill",
      manifest: { type: "skill", displayName: "My Skill", description: "A skill" },
      source: "local",
      type: "skill",
      createdBy: "user-1",
      createdAt: new Date(),
      updatedAt: new Date(),
      autoInstalled: false,
    };

    selectQueue = [
      [orgItem], // packages query (autoInstalled=false filter is in the SQL where clause)
      [], // packageDependencies
      [], // flow manifests for built-in counts
    ];

    const result = await listOrgItems("org-1", SKILL_CONFIG);

    // Should return the org item (auto-installed items are filtered out by the SQL query)
    const orgItems = result.filter((r) => r.source === "local");
    expect(orgItems).toHaveLength(1);
    expect(orgItems[0]!.id).toBe("my-skill");
  });
});

describe("deleteOrgItem — findRegistryDependents guard", () => {
  test("bloque le delete quand un package registry dépend de la cible → DEPENDED_ON", async () => {
    selectQueue = [
      // 1. packageDependencies refs (no flow refs → not IN_USE)
      [],
      // 2. findRegistryDependents: registry packages with manifests
      [
        {
          id: "@acme/parent",
          manifest: {
            displayName: "Parent Pkg",
            registryDependencies: { skills: { "@acme/target": "*" } },
          },
        },
      ],
    ];

    const result = await deleteOrgItem("org-1", "@acme/target", SKILL_CONFIG);

    expect(result.ok).toBe(false);
    expect(result.error).toBe("DEPENDED_ON");
    expect(result.dependents).toHaveLength(1);
    expect(result.dependents![0]!.id).toBe("@acme/parent");
    expect(deletedCount).toBe(0);
  });

  test("autorise le delete quand aucun package ne dépend de la cible", async () => {
    selectQueue = [
      [], // no flow refs
      [], // no registry dependents
    ];

    const result = await deleteOrgItem("org-1", "@acme/orphan", SKILL_CONFIG);

    expect(result.ok).toBe(true);
    expect(deletedCount).toBeGreaterThanOrEqual(1);
  });

  test("exclut le package cible lui-même des résultats de findRegistryDependents", async () => {
    selectQueue = [
      // no flow refs
      [],
      // registry packages: the target itself appears (self-dep in manifest)
      [
        {
          id: "@acme/target",
          manifest: {
            displayName: "Self",
            registryDependencies: { skills: { "@acme/target": "*" } },
          },
        },
      ],
    ];

    const result = await deleteOrgItem("org-1", "@acme/target", SKILL_CONFIG);

    // Self-reference should be excluded → delete allowed
    expect(result.ok).toBe(true);
  });

  test("gère les packages sans manifest gracieusement", async () => {
    selectQueue = [
      [], // no flow refs
      // registry package with null manifest
      [
        {
          id: "@acme/other",
          manifest: null,
        },
      ],
    ];

    const result = await deleteOrgItem("org-1", "@acme/target", SKILL_CONFIG);

    // null manifest should be skipped → delete allowed
    expect(result.ok).toBe(true);
  });

  test("IN_USE prévaut sur DEPENDED_ON (vérifié en premier)", async () => {
    selectQueue = [
      // flow refs exist → IN_USE
      [{ packageId: "flow-1" }],
      // getPackageDisplayNames for flows
      [{ id: "flow-1", manifest: { displayName: "My Flow" } }],
      // findRegistryDependents would find dependents but is never reached
    ];

    const result = await deleteOrgItem("org-1", "@acme/target", SKILL_CONFIG);

    expect(result.ok).toBe(false);
    expect(result.error).toBe("IN_USE");
    expect(result.flows).toHaveLength(1);
    expect(deletedCount).toBe(0);
  });

  test("retourne dependents avec displayName fallback sur id", async () => {
    selectQueue = [
      [], // no flow refs
      // registry package with no displayName in manifest → fallback to id
      [
        {
          id: "@acme/dep",
          manifest: {
            registryDependencies: { skills: { "@acme/target": "*" } },
          },
        },
      ],
    ];

    const result = await deleteOrgItem("org-1", "@acme/target", SKILL_CONFIG);

    expect(result.ok).toBe(false);
    expect(result.error).toBe("DEPENDED_ON");
    // displayName should fallback to id
    expect(result.dependents![0]!.displayName).toBe("@acme/dep");
  });
});
