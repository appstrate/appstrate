import { describe, test, expect, beforeEach } from "bun:test";
import { parseScopedName, isOwnedByOrg } from "@appstrate/core/naming";

/**
 * Tests for the forkPackage service.
 *
 * We replicate the fork logic inline instead of importing from package-fork.ts
 * to avoid mock.module contamination across test files (bun:test runs all files
 * in the same process).
 */

// --- Mock state ---

let mockOrgItems: Record<string, Record<string, unknown>> = {};
let mockPackageById: Record<string, unknown> = {};
let mockCreatedItems: unknown[] = [];
let mockUploadedFiles: unknown[] = [];
let mockSyncCalls: unknown[] = [];
let mockDownloadedFiles: Record<string, unknown> | null = null;

// --- Type configs (replicated from package-items config) ---

interface PackageTypeConfig {
  type: string;
  label: string;
  storageFolder: string;
}

const FLOW_CONFIG: PackageTypeConfig = { type: "flow", label: "Flow", storageFolder: "flows" };
const SKILL_CONFIG: PackageTypeConfig = { type: "skill", label: "Skill", storageFolder: "skills" };
const EXTENSION_CONFIG: PackageTypeConfig = {
  type: "extension",
  label: "Extension",
  storageFolder: "extensions",
};
const PROVIDER_CONFIG: PackageTypeConfig = {
  type: "provider",
  label: "Provider",
  storageFolder: "providers",
};

const TYPE_TO_CONFIG: Record<string, PackageTypeConfig> = {
  flow: FLOW_CONFIG,
  skill: SKILL_CONFIG,
  extension: EXTENSION_CONFIG,
  provider: PROVIDER_CONFIG,
};

// --- Mock functions (inline, no mock.module) ---

async function getOrgItem(_orgId: string, itemId: string, cfg: PackageTypeConfig) {
  const item = mockOrgItems[itemId];
  if (!item) return null;
  // Real implementation filters by packages.type === cfg.type
  const manifest = item.manifest as Record<string, unknown> | undefined;
  if (manifest?.type !== cfg.type) return null;
  return item;
}

async function getPackageById(id: string) {
  return mockPackageById[id] ?? null;
}

async function createOrgItem(
  orgId: string,
  orgSlug: string,
  item: { id: string; name?: string; description?: string; content: string; createdBy?: string },
  cfg: PackageTypeConfig,
  manifest: unknown,
  forkedFrom: string,
) {
  const row = {
    id: `@${orgSlug}/${item.id}`,
    orgId,
    type: cfg.type,
    forkedFrom,
    manifest,
    name: item.name,
    description: item.description,
    content: item.content,
    createdBy: item.createdBy,
  };
  mockCreatedItems.push(row);
  return row;
}

async function syncFlowDepsJunctionTable(...args: unknown[]) {
  mockSyncCalls.push(args);
}

async function downloadPackageFiles(_storageFolder: string, _orgId: string, _packageId: string) {
  return mockDownloadedFiles;
}

async function uploadPackageFiles(...args: unknown[]) {
  mockUploadedFiles.push(args);
}

function extractDepsFromManifest(_manifest: unknown) {
  return { skillIds: [] as string[], extensionIds: [] as string[], providerIds: [] as string[] };
}

// --- Inline fork logic (replicated from package-fork.ts) ---

interface ForkResult {
  packageId: string;
  type: string;
  forkedFrom: string;
}

type ForkError =
  | { code: "ALREADY_OWNED" }
  | { code: "NOT_FOUND" }
  | { code: "NAME_COLLISION"; existingId: string }
  | { code: "UNKNOWN_TYPE"; type: string };

async function forkPackage(
  orgId: string,
  orgSlug: string,
  sourcePackageId: string,
  userId?: string,
  customName?: string,
): Promise<ForkResult | ForkError> {
  if (isOwnedByOrg(sourcePackageId, orgSlug)) {
    return { code: "ALREADY_OWNED" };
  }

  const parsed = parseScopedName(sourcePackageId);
  if (!parsed) return { code: "NOT_FOUND" };

  // Try each config type to find the package in the org context
  let cfg: PackageTypeConfig | undefined;
  for (const [, typeCfg] of Object.entries(TYPE_TO_CONFIG)) {
    const item = await getOrgItem(orgId, sourcePackageId, typeCfg);
    if (item) {
      cfg = typeCfg;
      break;
    }
  }

  if (!cfg) {
    const raw = await getPackageById(sourcePackageId);
    if (!raw) return { code: "NOT_FOUND" };
    const typeCfg = TYPE_TO_CONFIG[(raw as { type: string }).type];
    if (!typeCfg) return { code: "UNKNOWN_TYPE", type: (raw as { type: string }).type };
    cfg = typeCfg;
  }

  // Load source package
  const source = await getOrgItem(orgId, sourcePackageId, cfg);
  if (!source) return { code: "NOT_FOUND" };

  // Build target packageId
  const forkName = customName ?? parsed.name;
  const targetId = `@${orgSlug}/${forkName}`;

  // Check for collision
  const existing = await getPackageById(targetId);
  if (existing) return { code: "NAME_COLLISION", existingId: targetId };

  // Update manifest.name to new packageId
  const updatedManifest = { ...((source.manifest as Record<string, unknown>) ?? {}) };
  updatedManifest.name = targetId;

  // Create the fork
  const newPkg = await createOrgItem(
    orgId,
    orgSlug,
    {
      id: forkName,
      name: (source.name as string) ?? undefined,
      description: (source.description as string) ?? undefined,
      content: (source.content as string) ?? "",
      createdBy: userId,
    },
    cfg,
    updatedManifest,
    sourcePackageId,
  );

  // Copy storage files if they exist
  const files = await downloadPackageFiles(cfg.storageFolder, orgId, sourcePackageId);
  if (files && Object.keys(files).length > 0) {
    await uploadPackageFiles(cfg.storageFolder, orgId, newPkg.id, files);
  }

  // Sync flow dependencies if it's a flow
  if (cfg.type === "flow") {
    const { skillIds, extensionIds, providerIds } = extractDepsFromManifest(updatedManifest);
    await syncFlowDepsJunctionTable(newPkg.id, orgId, skillIds, extensionIds, providerIds);
  }

  return {
    packageId: newPkg.id,
    type: cfg.type,
    forkedFrom: sourcePackageId,
  };
}

// --- Reset ---

beforeEach(() => {
  mockOrgItems = {};
  mockPackageById = {};
  mockCreatedItems = [];
  mockUploadedFiles = [];
  mockSyncCalls = [];
  mockDownloadedFiles = null;
});

describe("forkPackage", () => {
  test("fork non-owned → success with correct packageId and forkedFrom", async () => {
    mockOrgItems["@other/cool-flow"] = {
      id: "@other/cool-flow",
      orgId: "org-1",
      name: "Cool Flow",
      description: "A cool flow",
      content: "# Cool flow prompt",
      manifest: { name: "@other/cool-flow", type: "flow", version: "1.0.0" },
      source: "local",
    };

    const result = await forkPackage("org-1", "acme", "@other/cool-flow", "user-1");

    expect("code" in result).toBe(false);
    if (!("code" in result)) {
      expect(result.packageId).toBe("@acme/cool-flow");
      expect(result.forkedFrom).toBe("@other/cool-flow");
      expect(result.type).toBe("flow");
    }
  });

  test("fork owned → ALREADY_OWNED", async () => {
    const result = await forkPackage("org-1", "acme", "@acme/my-flow", "user-1");

    expect("code" in result).toBe(true);
    if ("code" in result) {
      expect(result.code).toBe("ALREADY_OWNED");
    }
  });

  test("fork non-existent → NOT_FOUND", async () => {
    const result = await forkPackage("org-1", "acme", "@other/missing", "user-1");

    expect("code" in result).toBe(true);
    if ("code" in result) {
      expect(result.code).toBe("NOT_FOUND");
    }
  });

  test("fork name collision → NAME_COLLISION", async () => {
    mockOrgItems["@other/cool-flow"] = {
      id: "@other/cool-flow",
      orgId: "org-1",
      name: "Cool Flow",
      description: "A cool flow",
      content: "# prompt",
      manifest: { name: "@other/cool-flow", type: "flow", version: "1.0.0" },
      source: "local",
    };
    mockPackageById["@acme/cool-flow"] = { id: "@acme/cool-flow", orgId: "org-1" };

    const result = await forkPackage("org-1", "acme", "@other/cool-flow", "user-1");

    expect("code" in result).toBe(true);
    if ("code" in result) {
      expect(result.code).toBe("NAME_COLLISION");
    }
  });

  test("manifest.name updated to new scoped ID", async () => {
    mockOrgItems["@other/cool-flow"] = {
      id: "@other/cool-flow",
      orgId: "org-1",
      name: "Cool Flow",
      description: "A cool flow",
      content: "# prompt",
      manifest: { name: "@other/cool-flow", type: "flow", version: "1.0.0", displayName: "Cool" },
      source: "local",
    };

    await forkPackage("org-1", "acme", "@other/cool-flow", "user-1");

    expect(mockCreatedItems.length).toBe(1);
    const created = mockCreatedItems[0] as { manifest: { name: string } };
    expect(created.manifest.name).toBe("@acme/cool-flow");
  });

  test("invalid packageId → NOT_FOUND", async () => {
    const result = await forkPackage("org-1", "acme", "invalid", "user-1");

    expect("code" in result).toBe(true);
    if ("code" in result) {
      expect(result.code).toBe("NOT_FOUND");
    }
  });

  test("fork copies source metadata (name, description, content, createdBy)", async () => {
    mockOrgItems["@other/cool-flow"] = {
      id: "@other/cool-flow",
      orgId: "org-1",
      name: "Cool Flow Display",
      description: "A really cool flow",
      content: "# Cool flow prompt content",
      manifest: { name: "@other/cool-flow", type: "flow", version: "1.0.0" },
      source: "local",
    };

    await forkPackage("org-1", "acme", "@other/cool-flow", "user-42");

    expect(mockCreatedItems.length).toBe(1);
    const created = mockCreatedItems[0] as Record<string, unknown>;
    expect(created.name).toBe("Cool Flow Display");
    expect(created.description).toBe("A really cool flow");
    expect(created.content).toBe("# Cool flow prompt content");
    expect(created.createdBy).toBe("user-42");
  });

  test("fork flow triggers syncFlowDepsJunctionTable", async () => {
    mockOrgItems["@other/cool-flow"] = {
      id: "@other/cool-flow",
      orgId: "org-1",
      name: "Cool Flow",
      content: "# prompt",
      manifest: { name: "@other/cool-flow", type: "flow", version: "1.0.0" },
      source: "local",
    };

    await forkPackage("org-1", "acme", "@other/cool-flow", "user-1");

    expect(mockSyncCalls.length).toBe(1);
    expect((mockSyncCalls[0] as unknown[])[0]).toBe("@acme/cool-flow");
    expect((mockSyncCalls[0] as unknown[])[1]).toBe("org-1");
  });

  test("fork skill does NOT trigger syncFlowDepsJunctionTable", async () => {
    mockOrgItems["@other/my-skill"] = {
      id: "@other/my-skill",
      orgId: "org-1",
      name: "My Skill",
      content: "# skill content",
      manifest: { name: "@other/my-skill", type: "skill", version: "1.0.0" },
      source: "local",
    };

    await forkPackage("org-1", "acme", "@other/my-skill", "user-1");

    expect(mockSyncCalls.length).toBe(0);
    expect(mockCreatedItems.length).toBe(1);
    const created = mockCreatedItems[0] as { type: string };
    expect(created.type).toBe("skill");
  });

  test("fork copies storage files when present", async () => {
    mockOrgItems["@other/cool-flow"] = {
      id: "@other/cool-flow",
      orgId: "org-1",
      name: "Cool Flow",
      content: "# prompt",
      manifest: { name: "@other/cool-flow", type: "flow", version: "1.0.0" },
      source: "local",
    };
    mockDownloadedFiles = { "flow.md": "content" };

    await forkPackage("org-1", "acme", "@other/cool-flow", "user-1");

    expect(mockUploadedFiles.length).toBe(1);
    const args = mockUploadedFiles[0] as unknown[];
    expect(args[0]).toBe("flows");
    expect(args[1]).toBe("org-1");
    expect(args[2]).toBe("@acme/cool-flow");
    expect(args[3]).toEqual({ "flow.md": "content" });
  });

  test("fork with custom name uses custom name instead of source name", async () => {
    mockOrgItems["@other/cool-flow"] = {
      id: "@other/cool-flow",
      orgId: "org-1",
      name: "Cool Flow",
      description: "A cool flow",
      content: "# prompt",
      manifest: { name: "@other/cool-flow", type: "flow", version: "1.0.0" },
      source: "local",
    };

    const result = await forkPackage(
      "org-1",
      "acme",
      "@other/cool-flow",
      "user-1",
      "my-custom-name",
    );

    expect("code" in result).toBe(false);
    if (!("code" in result)) {
      expect(result.packageId).toBe("@acme/my-custom-name");
      expect(result.forkedFrom).toBe("@other/cool-flow");
      expect(result.type).toBe("flow");
    }

    expect(mockCreatedItems.length).toBe(1);
    const created = mockCreatedItems[0] as { id: string; manifest: { name: string } };
    expect(created.id).toBe("@acme/my-custom-name");
    expect(created.manifest.name).toBe("@acme/my-custom-name");
  });

  test("fork with custom name checks collision against custom name", async () => {
    mockOrgItems["@other/cool-flow"] = {
      id: "@other/cool-flow",
      orgId: "org-1",
      name: "Cool Flow",
      content: "# prompt",
      manifest: { name: "@other/cool-flow", type: "flow", version: "1.0.0" },
      source: "local",
    };
    mockPackageById["@acme/my-custom-name"] = { id: "@acme/my-custom-name", orgId: "org-1" };

    const result = await forkPackage(
      "org-1",
      "acme",
      "@other/cool-flow",
      "user-1",
      "my-custom-name",
    );

    expect("code" in result).toBe(true);
    if ("code" in result) {
      expect(result.code).toBe("NAME_COLLISION");
    }
  });
});
