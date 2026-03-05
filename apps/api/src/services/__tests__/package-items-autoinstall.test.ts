import { describe, test, expect, mock, beforeEach } from "bun:test";
import {
  queues,
  resetQueues,
  db,
  schemaStubs,
  builtinPackagesStub,
  packageStorageStub,
  tracking,
} from "./_db-mock.ts";

// --- Mocks ---

const noop = () => {};

mock.module("../../lib/logger.ts", () => ({
  logger: { debug: noop, info: noop, warn: noop, error: noop },
}));

mock.module("../../lib/db.ts", () => ({ db }));
mock.module("@appstrate/db/schema", () => schemaStubs);

// @appstrate/core/dependencies — NOT mocked (pure function)
// @appstrate/core/naming — NOT mocked (pure functions)

mock.module("../package-storage.ts", () => packageStorageStub);

mock.module("../flow-service.ts", () => ({
  getPackagesDir: () => "/tmp",
  isBuiltInFlow: () => false,
  getAllPackageIds: async () => [],
  getPackage: async () => null,
}));

mock.module("@appstrate/db/storage", () => ({
  ensureBucket: async () => {},
  uploadFile: async () => {},
  downloadFile: async () => null,
  deleteFile: async () => {},
}));

mock.module("../builtin-packages.ts", () => builtinPackagesStub);

// --- Import after mocks ---

const { deleteOrgItem, listOrgItems, createOrgItem, getOrgItem, SKILL_CONFIG } =
  await import("../package-items.ts");

// --- Tests ---

beforeEach(() => {
  resetQueues();
});

describe("listOrgItems — autoInstalled filter", () => {
  // NOTE: The autoInstalled=false SQL filter cannot be tested with the mocked DB
  // since the mock returns whatever is in the queue without applying WHERE clauses.
  // This test only verifies the result mapping logic.
  test("returns items from DB (autoInstalled filter applied in SQL query)", async () => {
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

    queues.select = [
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
  test("blocks delete when a registry package depends on target — DEPENDED_ON", async () => {
    queues.select = [
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
    expect(tracking.deleteCalls).toHaveLength(0);
  });

  test("allows delete when no package depends on target", async () => {
    queues.select = [
      [], // no flow refs
      [], // no registry dependents
    ];

    const result = await deleteOrgItem("org-1", "@acme/orphan", SKILL_CONFIG);

    expect(result.ok).toBe(true);
    expect(tracking.deleteCalls.length).toBeGreaterThanOrEqual(1);
  });

  test("excludes the target package itself from findRegistryDependents results", async () => {
    queues.select = [
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

  test("handles packages with null manifest gracefully", async () => {
    queues.select = [
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

  test("IN_USE takes precedence over DEPENDED_ON (checked first)", async () => {
    queues.select = [
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
    expect(tracking.deleteCalls).toHaveLength(0);
  });

  test("returns dependents with displayName fallback to id", async () => {
    queues.select = [
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

describe("createOrgItem", () => {
  beforeEach(() => {
    resetQueues();
  });

  test("inserts with minimal manifest when none provided", async () => {
    queues.insert = [[{ id: "@acme/my-skill", orgId: "org-1" }]];
    const result = await createOrgItem(
      "org-1",
      "acme",
      { id: "my-skill", content: "test content", createdBy: "user-1" },
      SKILL_CONFIG,
    );
    expect(result).toBeDefined();
    expect(tracking.insertCalls).toHaveLength(1);
    expect(tracking.insertCalls[0]!.id).toBe("@acme/my-skill");
    expect(tracking.insertCalls[0]!.type).toBe("skill");
  });

  test("uses provided manifest when given", async () => {
    queues.insert = [[{ id: "@acme/custom", orgId: "org-1" }]];
    await createOrgItem(
      "org-1",
      "acme",
      { id: "custom", content: "code", name: "Custom Skill", createdBy: "user-1" },
      SKILL_CONFIG,
      { version: "2.0.0", customField: true },
    );
    expect(tracking.insertCalls).toHaveLength(1);
    const manifest = tracking.insertCalls[0]!.manifest as Record<string, unknown>;
    expect(manifest.version).toBe("2.0.0");
    expect(manifest.displayName).toBe("Custom Skill");
    expect(manifest.type).toBe("skill");
  });

  test("uses full item.id as packageId when orgSlug is null", async () => {
    queues.insert = [[{ id: "bare-id", orgId: "org-1" }]];
    await createOrgItem(
      "org-1",
      null,
      { id: "bare-id", content: "test", createdBy: "user-1" },
      SKILL_CONFIG,
    );
    expect(tracking.insertCalls[0]!.id).toBe("bare-id");
  });
});

describe("getOrgItem", () => {
  beforeEach(() => {
    resetQueues();
  });

  test("returns null when item not found", async () => {
    queues.select = [
      [], // package lookup
    ];
    const result = await getOrgItem("org-1", "@acme/missing", SKILL_CONFIG);
    expect(result).toBeNull();
  });

  test("returns item with flow references", async () => {
    queues.select = [
      // package lookup
      [
        {
          id: "@acme/skill",
          orgId: "org-1",
          name: "skill",
          type: "skill",
          manifest: {},
          content: "code",
          source: "local",
          createdBy: "user-1",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      // depRefs (packageDependencies)
      [{ packageId: "flow-1" }],
      // getPackageDisplayNames for flows
      [{ id: "flow-1", manifest: { displayName: "My Flow" } }],
    ];
    const result = await getOrgItem("org-1", "@acme/skill", SKILL_CONFIG);
    expect(result).not.toBeNull();
    expect(result!.id).toBe("@acme/skill");
    expect(result!.flows).toHaveLength(1);
  });
});
