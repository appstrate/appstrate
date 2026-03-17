import { describe, test, expect, mock, beforeEach } from "bun:test";
import {
  queues,
  resetQueues,
  db,
  schemaStubs,
  packageStorageStub,
  packageItemsStorageStub,
  tracking,
} from "./_db-mock.ts";

// --- Mocks ---

const noop = () => {};

mock.module("../../lib/logger.ts", () => ({
  logger: { debug: noop, info: noop, warn: noop, error: noop },
}));

mock.module("../../lib/db.ts", () => ({ db }));
mock.module("@appstrate/db/schema", () => schemaStubs);
mock.module("../package-storage.ts", () => packageStorageStub);

mock.module("@appstrate/core/integrity", () => ({
  computeIntegrity: () => "sha256-test",
  verifyArtifactIntegrity: () => ({ valid: true }),
}));

const depsTracking = {
  storeCalls: [] as { versionId: number }[],
  clearCalls: [] as { versionId: number }[],
};

mock.module("../package-version-deps.ts", () => ({
  storeVersionDependencies: async (versionId: number) => {
    depsTracking.storeCalls.push({ versionId });
  },
  clearVersionDependencies: async (versionId: number) => {
    depsTracking.clearCalls.push({ versionId });
  },
}));

// --- Import after mocks ---

mock.module("../package-items/storage.ts", () => packageItemsStorageStub);

mock.module("../package-items/dependencies.ts", () => ({
  buildDependencies: async () => null,
}));

const {
  createPackageVersion,
  listPackageVersions,
  getLatestVersionId,
  getLatestVersionWithManifest,
  resolveVersion,
  getVersionForDownload,
  getVersionDetail,
  getVersionCount,
  yankVersion,
  deletePackageVersion,
  getMatchingDistTags,

  getVersionInfo,
  getLatestVersionCreatedAt,
  createVersionAndUpload,
  createVersionFromDraft,
  addDistTag,
  removeDistTag,
  replaceVersionContent,
} = await import("../package-versions-impl.ts");

// --- Tests ---

describe("createPackageVersion", () => {
  beforeEach(() => {
    resetQueues();
  });

  test("returns null for invalid semver", async () => {
    const result = await createPackageVersion({
      packageId: "pkg-1",
      version: "abc",
      integrity: "sha256-x",
      artifactSize: 100,
      manifest: {},
      orgId: "org-1",
      createdBy: "user-1",
    });
    expect(result).toBeNull();
  });

  test("returns existing row for VERSION_EXISTS", async () => {
    // tx.select for allExisting versions
    queues.select = [
      [{ version: "1.0.0" }], // allExisting
      [], // currentLatest dist-tag lookup
      [{ id: 42, version: "1.0.0" }], // existing row lookup
    ];

    const result = await createPackageVersion({
      packageId: "pkg-1",
      version: "1.0.0",
      integrity: "sha256-x",
      artifactSize: 100,
      manifest: {},
      orgId: "org-1",
      createdBy: "user-1",
    });
    expect(result).toEqual({ id: 42, version: "1.0.0" });
  });

  test("returns null for VERSION_NOT_HIGHER", async () => {
    queues.select = [
      [{ version: "2.0.0" }], // allExisting — 2.0.0 is higher than 1.0.0
      [{ version: "2.0.0" }], // currentLatest dist-tag lookup
    ];

    const result = await createPackageVersion({
      packageId: "pkg-1",
      version: "1.0.0",
      integrity: "sha256-x",
      artifactSize: 100,
      manifest: {},
      orgId: "org-1",
      createdBy: "user-1",
    });
    expect(result).toBeNull();
  });

  test("inserts and returns new version on happy path", async () => {
    queues.select = [
      [], // allExisting — no versions yet
      [], // currentLatest dist-tag lookup (innerJoin)
    ];
    queues.insert = [
      [{ id: 1, version: "1.0.0" }], // insert returning
    ];

    const result = await createPackageVersion({
      packageId: "pkg-1",
      version: "1.0.0",
      integrity: "sha256-x",
      artifactSize: 100,
      manifest: {},
      orgId: "org-1",
      createdBy: "user-1",
    });
    expect(result).toEqual({ id: 1, version: "1.0.0" });
  });

  test("auto-updates latest dist-tag for stable version", async () => {
    queues.select = [
      [], // allExisting
      [], // currentLatest — no existing latest tag
    ];
    queues.insert = [
      [{ id: 1, version: "1.0.0" }], // insert returning
    ];

    // shouldUpdateLatestTag(1.0.0, null) → true → will call insert for dist-tag
    const result = await createPackageVersion({
      packageId: "pkg-1",
      version: "1.0.0",
      integrity: "sha256-x",
      artifactSize: 100,
      manifest: {},
      orgId: "org-1",
      createdBy: "user-1",
    });
    expect(result).not.toBeNull();
    // Should have 2 inserts: version row + dist-tag upsert
    expect(tracking.insertCalls).toHaveLength(2);
    const distTagInsert = tracking.insertCalls.find((c) => "tag" in c && c.tag === "latest");
    expect(distTagInsert).toMatchObject({ tag: "latest", versionId: 1 });
  });

  test("does not update latest dist-tag for prerelease", async () => {
    queues.select = [
      [], // allExisting
      [{ version: "1.0.0" }], // currentLatest exists
    ];
    queues.insert = [[{ id: 2, version: "1.1.0-beta.1" }]];

    // shouldUpdateLatestTag("1.1.0-beta.1", "1.0.0") → false (prerelease)
    const result = await createPackageVersion({
      packageId: "pkg-1",
      version: "1.1.0-beta.1",
      integrity: "sha256-x",
      artifactSize: 100,
      manifest: {},
      orgId: "org-1",
      createdBy: "user-1",
    });
    expect(result).toEqual({ id: 2, version: "1.1.0-beta.1" });
  });

  test("returns null on transaction error", async () => {
    queues.select = [
      [], // allExisting
      [], // currentLatest
    ];
    // insertQueue empty → insert.returning returns [] → [row] destructures to undefined → return null

    const result = await createPackageVersion({
      packageId: "pkg-1",
      version: "1.0.0",
      integrity: "sha256-x",
      artifactSize: 100,
      manifest: {},
      orgId: "org-1",
      createdBy: "user-1",
    });
    expect(result).toBeNull();
  });
});

describe("resolveVersion", () => {
  beforeEach(() => {
    resetQueues();
  });

  test("resolves exact match", async () => {
    queues.select = [
      [{ id: 5, version: "1.0.0", yanked: false }], // allVersions
      [], // allDistTags
    ];
    const result = await resolveVersion("pkg-1", "1.0.0");
    expect(result).toBe(5);
  });

  test("resolves dist-tag match", async () => {
    queues.select = [
      [{ id: 5, version: "1.0.0", yanked: false }], // allVersions
      [{ tag: "latest", versionId: 5 }], // allDistTags
    ];
    const result = await resolveVersion("pkg-1", "latest");
    expect(result).toBe(5);
  });

  test("returns null for no match", async () => {
    queues.select = [
      [{ id: 5, version: "1.0.0", yanked: false }], // allVersions
      [], // allDistTags
    ];
    const result = await resolveVersion("pkg-1", "9.9.9");
    expect(result).toBeNull();
  });
});

describe("yankVersion", () => {
  beforeEach(() => {
    resetQueues();
  });

  test("returns false when version not found", async () => {
    queues.update = [[]]; // update returns nothing
    const result = await yankVersion("pkg-1", "1.0.0");
    expect(result).toBe(false);
  });

  test("yanks and reassigns dist-tags to best stable", async () => {
    queues.update = [
      [{ id: 10 }], // yanked row returned
    ];
    queues.select = [
      [{ tag: "latest" }], // affectedTags
      [{ id: 9, version: "0.9.0" }], // candidates (non-yanked)
    ];
    queues.update.push([]); // dist-tag update

    const result = await yankVersion("pkg-1", "1.0.0");
    expect(result).toBe(true);
  });

  test("yanks and deletes dist-tags when no candidates", async () => {
    queues.update = [
      [{ id: 10 }], // yanked row
    ];
    queues.select = [
      [{ tag: "latest" }], // affectedTags
      [], // no candidates
    ];
    queues.delete = [[]]; // dist-tag delete

    const result = await yankVersion("pkg-1", "1.0.0");
    expect(result).toBe(true);
  });
});

describe("listPackageVersions", () => {
  beforeEach(() => {
    resetQueues();
  });

  test("returns empty array when no versions", async () => {
    queues.select = [[]];
    const result = await listPackageVersions("pkg-1");
    expect(result).toEqual([]);
  });

  test("maps rows with createdAt.toISOString()", async () => {
    const date = new Date("2025-01-15T10:00:00Z");
    queues.select = [
      [
        {
          id: 1,
          version: "1.0.0",
          integrity: "sha256-x",
          artifactSize: 100,
          yanked: false,
          createdBy: "user-1",
          createdAt: date,
        },
      ],
    ];
    const result = await listPackageVersions("pkg-1");
    expect(result).toHaveLength(1);
    expect(result[0]!.createdAt).toBe("2025-01-15T10:00:00.000Z");
    expect(result[0]!.version).toBe("1.0.0");
  });
});

describe("getLatestVersionId", () => {
  beforeEach(() => {
    resetQueues();
  });

  test("returns versionId from latest dist-tag", async () => {
    queues.select = [[{ versionId: 42 }]];
    const result = await getLatestVersionId("pkg-1");
    expect(result).toBe(42);
  });

  test("falls back to highest id when no dist-tag", async () => {
    queues.select = [
      [], // no dist-tag
      [{ id: 99 }], // highest by id
    ];
    const result = await getLatestVersionId("pkg-1");
    expect(result).toBe(99);
  });

  test("returns null when no versions exist", async () => {
    queues.select = [
      [], // no dist-tag
      [], // no versions
    ];
    const result = await getLatestVersionId("pkg-1");
    expect(result).toBeNull();
  });
});

describe("getLatestVersionWithManifest", () => {
  beforeEach(() => {
    resetQueues();
  });

  test("returns id + manifest via dist-tag", async () => {
    queues.select = [
      [{ versionId: 42 }], // dist-tag lookup
      [{ id: 42, manifest: { name: "test" } }], // version row
    ];
    const result = await getLatestVersionWithManifest("pkg-1");
    expect(result).toEqual({ id: 42, manifest: { name: "test" } });
  });

  test("falls back when no dist-tag", async () => {
    queues.select = [
      [], // no dist-tag
      [{ id: 99 }], // highest by id
      [{ id: 99, manifest: { name: "fallback" } }], // version row
    ];
    const result = await getLatestVersionWithManifest("pkg-1");
    expect(result).toEqual({ id: 99, manifest: { name: "fallback" } });
  });

  test("returns null when no versions exist", async () => {
    queues.select = [
      [], // no dist-tag
      [], // no versions
    ];
    const result = await getLatestVersionWithManifest("pkg-1");
    expect(result).toBeNull();
  });
});

describe("getVersionCount", () => {
  beforeEach(() => {
    resetQueues();
  });

  test("returns count from query", async () => {
    queues.select = [[{ count: 5 }]];
    const result = await getVersionCount("pkg-1");
    expect(result).toBe(5);
  });

  test("returns 0 when no row", async () => {
    queues.select = [[]];
    const result = await getVersionCount("pkg-1");
    expect(result).toBe(0);
  });
});

describe("getMatchingDistTags", () => {
  beforeEach(() => {
    resetQueues();
  });

  test("returns tags matching the version", async () => {
    // listDistTags does a select with innerJoin
    queues.select = [
      [
        { tag: "latest", version: "1.0.0" },
        { tag: "stable", version: "1.0.0" },
        { tag: "beta", version: "2.0.0-beta" },
      ],
    ];
    const result = await getMatchingDistTags("pkg-1", "1.0.0");
    expect(result).toEqual(["latest", "stable"]);
  });

  test("returns empty array when no tags match", async () => {
    queues.select = [[{ tag: "latest", version: "2.0.0" }]];
    const result = await getMatchingDistTags("pkg-1", "1.0.0");
    expect(result).toEqual([]);
  });
});

describe("getLatestVersionCreatedAt", () => {
  beforeEach(() => {
    resetQueues();
  });

  test("returns date when versions exist", async () => {
    const date = new Date("2025-06-01T00:00:00Z");
    queues.select = [[{ createdAt: date }]];
    const result = await getLatestVersionCreatedAt("pkg-1");
    expect(result).toEqual(date);
  });

  test("returns null when no versions", async () => {
    queues.select = [[]];
    const result = await getLatestVersionCreatedAt("pkg-1");
    expect(result).toBeNull();
  });
});

describe("getVersionInfo", () => {
  beforeEach(() => {
    resetQueues();
  });

  test("returns both values when present", async () => {
    // Promise.all: [pkg select, latestTag select]
    queues.select = [
      [{ draftManifest: { version: "2.0.0" } }], // pkg
      [{ versionId: 5 }], // latestTag
      [{ version: "1.0.0" }], // version row for latestTag
    ];
    const result = await getVersionInfo("pkg-1");
    expect(result.draftVersion).toBe("2.0.0");
    expect(result.latestVersion).toBe("1.0.0");
  });

  test("returns null latestVersion when no dist-tag", async () => {
    queues.select = [
      [{ draftManifest: { version: "1.0.0" } }], // pkg
      [], // no latestTag
    ];
    const result = await getVersionInfo("pkg-1");
    expect(result.draftVersion).toBe("1.0.0");
    expect(result.latestVersion).toBeNull();
  });

  test("returns null draftVersion when manifest has no version", async () => {
    queues.select = [
      [{ draftManifest: {} }], // pkg — no version field
      [], // no latestTag
    ];
    const result = await getVersionInfo("pkg-1");
    expect(result.draftVersion).toBeNull();
    expect(result.latestVersion).toBeNull();
  });
});

describe("getVersionForDownload", () => {
  beforeEach(() => {
    resetQueues();
  });

  test("returns version row on exact match", async () => {
    queues.select = [
      [{ id: 5, version: "1.0.0", yanked: false }], // resolveVersion: allVersions
      [], // resolveVersion: allDistTags
      [{ id: 5, version: "1.0.0", integrity: "sha256-x", artifactSize: 100, yanked: false }],
    ];
    const result = await getVersionForDownload("pkg-1", "1.0.0");
    expect(result).toMatchObject({ id: 5, version: "1.0.0" });
  });

  test("returns null when version cannot be resolved", async () => {
    queues.select = [
      [{ id: 5, version: "1.0.0", yanked: false }], // allVersions
      [], // allDistTags
    ];
    const result = await getVersionForDownload("pkg-1", "9.9.9");
    expect(result).toBeNull();
  });

  test("resolves via dist-tag", async () => {
    queues.select = [
      [{ id: 5, version: "1.0.0", yanked: false }], // allVersions
      [{ tag: "latest", versionId: 5 }], // allDistTags
      [{ id: 5, version: "1.0.0", integrity: "sha256-x", artifactSize: 100, yanked: false }],
    ];
    const result = await getVersionForDownload("pkg-1", "latest");
    expect(result).toMatchObject({ id: 5, version: "1.0.0" });
  });
});

describe("getVersionDetail", () => {
  beforeEach(() => {
    resetQueues();
  });

  test("returns null when version cannot be resolved", async () => {
    queues.select = [
      [{ id: 5, version: "1.0.0", yanked: false }], // allVersions
      [], // allDistTags
    ];
    const result = await getVersionDetail("pkg-1", "9.9.9");
    expect(result).toBeNull();
  });

  test("returns detail with null prompt when no ZIP available", async () => {
    queues.select = [
      [{ id: 5, version: "1.0.0", yanked: false }], // allVersions
      [], // allDistTags
      [
        {
          id: 5,
          version: "1.0.0",
          manifest: { name: "test" },
          integrity: "sha256-x",
          artifactSize: 100,
          yanked: false,
          yankedReason: null,
          createdAt: new Date("2025-01-01T00:00:00Z"),
        },
      ],
    ];
    // downloadVersionZip returns null (default mock)
    const result = await getVersionDetail("pkg-1", "1.0.0");
    expect(result).not.toBeNull();
    expect(result!.textContent).toBeNull();
    expect(result!.version).toBe("1.0.0");
    expect(result!.createdAt).toBe("2025-01-01T00:00:00.000Z");
  });

  test("returns null when row missing after resolution", async () => {
    queues.select = [
      [{ id: 5, version: "1.0.0", yanked: false }], // resolveVersion: allVersions
      [], // resolveVersion: allDistTags — exact match resolves
      [], // row lookup after resolution — empty (race condition / deleted)
    ];
    const result = await getVersionDetail("pkg-1", "1.0.0");
    expect(result).toBeNull();
  });
});

describe("addDistTag", () => {
  beforeEach(() => {
    resetQueues();
  });

  test("rejects protected tag 'latest'", async () => {
    expect(addDistTag("pkg-1", "latest", 1)).rejects.toThrow("'latest' tag cannot be set manually");
  });

  test("inserts valid tag", async () => {
    await addDistTag("pkg-1", "beta", 1);
    expect(tracking.insertCalls).toHaveLength(1);
    expect(tracking.insertCalls[0]).toMatchObject({ tag: "beta", versionId: 1 });
  });

  test("rejects invalid tag name", async () => {
    expect(addDistTag("pkg-1", "not valid!", 1)).rejects.toThrow("Invalid tag name");
  });
});

describe("removeDistTag", () => {
  beforeEach(() => {
    resetQueues();
  });

  test("rejects protected tag 'latest'", async () => {
    expect(removeDistTag("pkg-1", "latest")).rejects.toThrow("'latest' tag cannot be removed");
  });

  test("deletes non-protected tag", async () => {
    queues.delete = [[]];
    await removeDistTag("pkg-1", "beta");
    expect(tracking.deleteCalls).toHaveLength(1);
  });
});

describe("createVersionAndUpload", () => {
  beforeEach(() => {
    resetQueues();
  });

  test("returns null for invalid semver", async () => {
    const result = await createVersionAndUpload({
      packageId: "pkg-1",
      version: "invalid",
      orgId: "org-1",
      createdBy: "user-1",
      zipBuffer: Buffer.from([1, 2, 3]),
      manifest: {},
    });
    expect(result).toBeNull();
  });

  test("creates version and uploads ZIP on happy path", async () => {
    queues.select = [
      [], // allExisting
      [], // currentLatest
    ];
    queues.insert = [[{ id: 1, version: "1.0.0" }]];

    const result = await createVersionAndUpload({
      packageId: "pkg-1",
      version: "1.0.0",
      orgId: "org-1",
      createdBy: "user-1",
      zipBuffer: Buffer.from([1, 2, 3]),
      manifest: {},
    });
    expect(result).toEqual({ id: 1, version: "1.0.0" });
  });

  test("stores version dependencies when manifest has deps", async () => {
    queues.select = [
      [], // allExisting
      [], // currentLatest
    ];
    queues.insert = [[{ id: 1, version: "1.0.0" }]];

    const result = await createVersionAndUpload({
      packageId: "pkg-1",
      version: "1.0.0",
      orgId: "org-1",
      createdBy: "user-1",
      zipBuffer: Buffer.from([1, 2, 3]),
      manifest: {
        dependencies: { skills: { "@acme/helper": "*" } },
      },
    });
    expect(result).toEqual({ id: 1, version: "1.0.0" });
  });
});

describe("createVersionFromDraft", () => {
  beforeEach(() => {
    resetQueues();
  });

  test("returns null when package not found", async () => {
    queues.select = [[]]; // pkg lookup — empty
    const result = await createVersionFromDraft({
      packageId: "pkg-1",
      orgId: "org-1",
      userId: "user-1",
    });
    expect(result).toBeNull();
  });

  test("returns null when manifest has no version", async () => {
    queues.select = [[{ draftManifest: {}, draftContent: "test", type: "flow" }]];
    const result = await createVersionFromDraft({
      packageId: "pkg-1",
      orgId: "org-1",
      userId: "user-1",
    });
    expect(result).toBeNull();
  });

  test("returns null for invalid semver in manifest", async () => {
    queues.select = [
      [{ draftManifest: { version: "not-valid" }, draftContent: "test", type: "flow" }],
    ];
    const result = await createVersionFromDraft({
      packageId: "pkg-1",
      orgId: "org-1",
      userId: "user-1",
    });
    expect(result).toBeNull();
  });

  test("creates version from flow type draft", async () => {
    // pkg lookup
    queues.select = [
      [
        {
          draftManifest: { version: "1.0.0", name: "test" },
          draftContent: "prompt content",
          type: "flow",
        },
      ],
      [], // createPackageVersion: allExisting
      [], // createPackageVersion: currentLatest
    ];
    queues.insert = [[{ id: 1, version: "1.0.0" }]];

    const result = await createVersionFromDraft({
      packageId: "pkg-1",
      orgId: "org-1",
      userId: "user-1",
    });
    expect(result).toEqual({ id: 1, version: "1.0.0" });
  });
});

describe("replaceVersionContent", () => {
  beforeEach(() => {
    resetQueues();
    depsTracking.storeCalls.length = 0;
    depsTracking.clearCalls.length = 0;
  });

  test("updates version row, clears old deps, and stores new deps", async () => {
    queues.update = [
      [{ id: 7 }], // update returning
    ];

    await replaceVersionContent({
      packageId: "@acme/flow-1",
      version: "1.0.0",
      zipBuffer: Buffer.from([1, 2, 3]),
      manifest: {
        dependencies: { skills: { "@acme/helper": "*" } },
      },
    });

    // Should have updated integrity, artifactSize, manifest
    expect(tracking.updateCalls).toHaveLength(1);
    expect(tracking.updateCalls[0]).toMatchObject({
      integrity: "sha256-test",
      artifactSize: 3,
    });

    // Should clear old deps then store new ones
    expect(depsTracking.clearCalls).toEqual([{ versionId: 7 }]);
    expect(depsTracking.storeCalls).toEqual([{ versionId: 7 }]);
  });

  test("clears deps but does not store when new manifest has no deps", async () => {
    queues.update = [
      [{ id: 7 }], // update returning
    ];

    await replaceVersionContent({
      packageId: "@acme/flow-1",
      version: "1.0.0",
      zipBuffer: Buffer.from([4, 5]),
      manifest: { name: "test" }, // no dependencies
    });

    expect(depsTracking.clearCalls).toEqual([{ versionId: 7 }]);
    expect(depsTracking.storeCalls).toEqual([]); // no new deps to store
  });

  test("returns early when version row not found", async () => {
    queues.update = [
      [], // update returning — empty (no row matched)
    ];

    await replaceVersionContent({
      packageId: "@acme/flow-1",
      version: "9.9.9",
      zipBuffer: Buffer.from([1]),
      manifest: {},
    });

    // Should not attempt dep operations
    expect(depsTracking.clearCalls).toEqual([]);
    expect(depsTracking.storeCalls).toEqual([]);
  });
});

describe("createVersionFromDraft — skill/tool error on missing files", () => {
  beforeEach(() => {
    resetQueues();
    // Ensure downloadPackageFiles returns null (no stored files)
    packageItemsStorageStub.downloadPackageFiles = async () => null;
  });

  test("throws error for skill when storage files are missing", async () => {
    queues.select = [
      [
        {
          draftManifest: { version: "1.0.0", name: "@acme/my-skill" },
          draftContent: "skill content",
          type: "skill",
        },
      ],
    ];

    const promise = createVersionFromDraft({
      packageId: "@acme/my-skill",
      orgId: "org-1",
      userId: "user-1",
    });
    await expect(promise).rejects.toThrow(
      "Cannot create version for @acme/my-skill: package files not found in storage",
    );
  });

  test("throws error for tool when storage files are missing", async () => {
    queues.select = [
      [
        {
          draftManifest: { version: "1.0.0", name: "@acme/my-ext" },
          draftContent: "ext content",
          type: "tool",
        },
      ],
    ];

    const promise = createVersionFromDraft({
      packageId: "@acme/my-ext",
      orgId: "org-1",
      userId: "user-1",
    });
    await expect(promise).rejects.toThrow(
      "Cannot create version for @acme/my-ext: package files not found in storage",
    );
  });
});

describe("createVersionFromDraft — flow stored files round-trip", () => {
  beforeEach(() => {
    resetQueues();
  });

  test("uses stored files when available for flow", async () => {
    const storedFiles: Record<string, Uint8Array> = {
      "manifest.json": new TextEncoder().encode("{}"),
      "prompt.md": new TextEncoder().encode("old prompt"),
      "extra-file.txt": new TextEncoder().encode("extra content"),
    };
    packageItemsStorageStub.downloadPackageFiles = async () => storedFiles;

    queues.select = [
      [
        {
          draftManifest: { version: "1.0.0", name: "test-flow" },
          draftContent: "updated prompt",
          type: "flow",
        },
      ],
      [], // createPackageVersion: allExisting
      [], // createPackageVersion: currentLatest
    ];
    queues.insert = [[{ id: 1, version: "1.0.0" }]];

    const result = await createVersionFromDraft({
      packageId: "test-flow",
      orgId: "org-1",
      userId: "user-1",
    });
    expect(result).toEqual({ id: 1, version: "1.0.0" });
  });

  test("falls back to minimal ZIP when no stored files for flow", async () => {
    packageItemsStorageStub.downloadPackageFiles = async () => null;

    queues.select = [
      [
        {
          draftManifest: { version: "1.0.0", name: "test-flow" },
          draftContent: "prompt content",
          type: "flow",
        },
      ],
      [], // createPackageVersion: allExisting
      [], // createPackageVersion: currentLatest
    ];
    queues.insert = [[{ id: 1, version: "1.0.0" }]];

    const result = await createVersionFromDraft({
      packageId: "test-flow",
      orgId: "org-1",
      userId: "user-1",
    });
    expect(result).toEqual({ id: 1, version: "1.0.0" });
  });
});

describe("advisory lock tracking", () => {
  beforeEach(() => {
    resetQueues();
  });

  test("createPackageVersion acquires advisory lock", async () => {
    queues.select = [
      [], // allExisting
      [], // currentLatest
    ];
    queues.insert = [[{ id: 1, version: "1.0.0" }]];

    await createPackageVersion({
      packageId: "pkg-1",
      version: "1.0.0",
      integrity: "sha256-x",
      artifactSize: 100,
      manifest: {},
      orgId: "org-1",
      createdBy: "user-1",
    });

    expect(tracking.executeCalls.length).toBeGreaterThanOrEqual(1);
  });

  test("yankVersion acquires advisory lock", async () => {
    queues.update = [[{ id: 10 }]];
    queues.select = [
      [], // affectedTags — none
    ];

    await yankVersion("pkg-1", "1.0.0");

    expect(tracking.executeCalls.length).toBeGreaterThanOrEqual(1);
  });

  test("deletePackageVersion acquires advisory lock", async () => {
    queues.select = [
      [{ id: 10 }], // version row found
      [], // no affected tags
    ];
    queues.delete = [[]]; // version delete

    await deletePackageVersion("pkg-1", "1.0.0");

    expect(tracking.executeCalls.length).toBeGreaterThanOrEqual(1);
  });
});

describe("deletePackageVersion", () => {
  beforeEach(() => {
    resetQueues();
  });

  test("returns false when version not found", async () => {
    queues.select = [[]]; // no version row
    const result = await deletePackageVersion("pkg-1", "1.0.0");
    expect(result).toBe(false);
  });

  test("deletes version and reassigns dist-tags", async () => {
    queues.select = [
      [{ id: 10 }], // version row
      [{ tag: "latest" }], // affectedTags
      [
        { id: 9, version: "0.9.0" },
        { id: 10, version: "1.0.0" },
      ], // candidates (includes self)
    ];
    queues.update.push([]); // dist-tag update
    queues.delete = [[]]; // version delete

    const result = await deletePackageVersion("pkg-1", "1.0.0");
    expect(result).toBe(true);
  });
});
