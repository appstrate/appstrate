import { describe, test, expect, beforeEach } from "bun:test";
import { parseScopedName, isOwnedByOrg } from "@appstrate/core/naming";
import { zipArtifact, unzipArtifact } from "@appstrate/core/zip";

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
let mockLatestVersionId: Record<string, number | null> = {};
let mockVersionRows: Record<
  number,
  { version: string; manifest: Record<string, unknown>; integrity: string }
> = {};
let mockVersionZips: Record<string, Buffer | null> = {};
let mockCreatedVersions: unknown[] = [];

// --- Type configs (replicated from package-items config) ---

interface PackageTypeConfig {
  type: string;
  label: string;
  storageFolder: string;
}

const FLOW_CONFIG: PackageTypeConfig = { type: "flow", label: "Flow", storageFolder: "flows" };
const SKILL_CONFIG: PackageTypeConfig = { type: "skill", label: "Skill", storageFolder: "skills" };
const TOOL_CONFIG: PackageTypeConfig = {
  type: "tool",
  label: "Tool",
  storageFolder: "tools",
};
const PROVIDER_CONFIG: PackageTypeConfig = {
  type: "provider",
  label: "Provider",
  storageFolder: "providers",
};

const TYPE_TO_CONFIG: Record<string, PackageTypeConfig> = {
  flow: FLOW_CONFIG,
  skill: SKILL_CONFIG,
  tool: TOOL_CONFIG,
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

async function uploadPackageFiles(...args: unknown[]) {
  mockUploadedFiles.push(args);
}

function extractDepsFromManifest(_manifest: unknown) {
  return { skillIds: [] as string[], toolIds: [] as string[], providerIds: [] as string[] };
}

async function getLatestVersionId(packageId: string): Promise<number | null> {
  return mockLatestVersionId[packageId] ?? null;
}

function getVersionRow(versionId: number) {
  return mockVersionRows[versionId] ?? null;
}

function downloadVersionZip(packageId: string, version: string): Buffer | null {
  return mockVersionZips[`${packageId}@${version}`] ?? null;
}

async function createVersionAndUpload(params: {
  packageId: string;
  version: string;
  orgId: string | null;
  createdBy: string | null;
  zipBuffer: Buffer;
  manifest: Record<string, unknown>;
}): Promise<{ id: number; version: string } | null> {
  const entry = { ...params, id: mockCreatedVersions.length + 1 };
  mockCreatedVersions.push(entry);
  return { id: entry.id, version: params.version };
}

// --- Helper: build a minimal ZIP for testing ---

function buildTestZip(
  manifest: Record<string, unknown>,
  content: string,
  contentFileName = "prompt.md",
): Buffer {
  const entries: Record<string, Uint8Array> = {
    "manifest.json": new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
    [contentFileName]: new TextEncoder().encode(content),
  };
  return Buffer.from(zipArtifact(entries, 6));
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
  | { code: "UNKNOWN_TYPE"; type: string }
  | { code: "NO_PUBLISHED_VERSION" };

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

  // Resolve latest published version
  const latestVersionId = await getLatestVersionId(sourcePackageId);
  if (!latestVersionId) return { code: "NO_PUBLISHED_VERSION" };

  const versionRow = getVersionRow(latestVersionId);
  if (!versionRow) return { code: "NO_PUBLISHED_VERSION" };

  // Download source version ZIP
  const sourceZip = downloadVersionZip(sourcePackageId, versionRow.version);
  if (!sourceZip) return { code: "NO_PUBLISHED_VERSION" };

  // Extract content from ZIP
  const zipEntries = unzipArtifact(new Uint8Array(sourceZip));
  const decoder = new TextDecoder();
  const content = zipEntries["prompt.md"]
    ? decoder.decode(zipEntries["prompt.md"])
    : zipEntries["SKILL.md"]
      ? decoder.decode(zipEntries["SKILL.md"])
      : "";

  // Build target packageId
  const forkName = customName ?? parsed.name;
  const targetId = `@${orgSlug}/${forkName}`;

  // Check for collision
  const existing = await getPackageById(targetId);
  if (existing) return { code: "NAME_COLLISION", existingId: targetId };

  // Build manifest from version snapshot
  const versionManifest = (versionRow.manifest ?? {}) as Record<string, unknown>;
  const updatedManifest = { ...versionManifest, name: targetId };

  // Create the fork
  const newPkg = await createOrgItem(
    orgId,
    orgSlug,
    {
      id: forkName,
      name: (versionManifest.displayName as string) ?? undefined,
      description: (versionManifest.description as string) ?? undefined,
      content,
      createdBy: userId,
    },
    cfg,
    updatedManifest,
    sourcePackageId,
  );

  // Build draft storage files from the version ZIP entries
  const draftFiles: Record<string, Uint8Array> = {};
  for (const [path, data] of Object.entries(zipEntries)) {
    if (path === "manifest.json") continue;
    draftFiles[path] = data;
  }
  draftFiles["manifest.json"] = new TextEncoder().encode(JSON.stringify(updatedManifest, null, 2));
  await uploadPackageFiles(cfg.storageFolder, orgId, newPkg.id, draftFiles);

  const newZipBuffer = Buffer.from(zipArtifact(draftFiles, 6));

  // Create local published version
  await createVersionAndUpload({
    packageId: newPkg.id,
    version: versionRow.version,
    orgId,
    createdBy: userId ?? null,
    zipBuffer: newZipBuffer,
    manifest: updatedManifest,
  });

  // Sync flow dependencies if it's a flow
  if (cfg.type === "flow") {
    const { skillIds, toolIds, providerIds } = extractDepsFromManifest(updatedManifest);
    await syncFlowDepsJunctionTable(newPkg.id, orgId, skillIds, toolIds, providerIds);
  }

  return {
    packageId: newPkg.id,
    type: cfg.type,
    forkedFrom: sourcePackageId,
  };
}

// --- Helper: set up a source package with a published version ---

function setupSourcePackage(opts: {
  packageId: string;
  type: string;
  version?: string;
  content?: string;
  displayName?: string;
  description?: string;
  manifest?: Record<string, unknown>;
}) {
  const version = opts.version ?? "1.0.0";
  const content = opts.content ?? "# prompt";
  const manifest = opts.manifest ?? {
    name: opts.packageId,
    type: opts.type,
    version,
    ...(opts.displayName ? { displayName: opts.displayName } : {}),
    ...(opts.description ? { description: opts.description } : {}),
  };

  // Set up org item (for type detection)
  mockOrgItems[opts.packageId] = {
    id: opts.packageId,
    orgId: "org-1",
    name: opts.displayName ?? opts.packageId,
    description: opts.description ?? null,
    content,
    manifest,
    source: "local",
  };

  // Set up published version
  const versionId = Object.keys(mockVersionRows).length + 1;
  mockLatestVersionId[opts.packageId] = versionId;
  mockVersionRows[versionId] = {
    version,
    manifest,
    integrity: "sha256-test",
  };

  // Build and store the version ZIP
  const contentFileName = opts.type === "skill" ? "SKILL.md" : "prompt.md";
  const zip = buildTestZip(manifest, content, contentFileName);
  mockVersionZips[`${opts.packageId}@${version}`] = zip;
}

// --- Reset ---

beforeEach(() => {
  mockOrgItems = {};
  mockPackageById = {};
  mockCreatedItems = [];
  mockUploadedFiles = [];
  mockSyncCalls = [];
  mockLatestVersionId = {};
  mockVersionRows = {};
  mockVersionZips = {};
  mockCreatedVersions = [];
});

describe("forkPackage", () => {
  test("fork non-owned with published version → success", async () => {
    setupSourcePackage({
      packageId: "@other/cool-flow",
      type: "flow",
      content: "# Cool flow prompt",
      displayName: "Cool Flow",
      description: "A cool flow",
    });

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

  test("fork package with no published version → NO_PUBLISHED_VERSION", async () => {
    // Set up org item but NO published version
    mockOrgItems["@other/draft-only"] = {
      id: "@other/draft-only",
      orgId: "org-1",
      name: "Draft Only",
      content: "# draft",
      manifest: { name: "@other/draft-only", type: "flow", version: "1.0.0" },
      source: "local",
    };
    // No entry in mockLatestVersionId → getLatestVersionId returns null

    const result = await forkPackage("org-1", "acme", "@other/draft-only", "user-1");

    expect("code" in result).toBe(true);
    if ("code" in result) {
      expect(result.code).toBe("NO_PUBLISHED_VERSION");
    }
  });

  test("fork name collision → NAME_COLLISION", async () => {
    setupSourcePackage({
      packageId: "@other/cool-flow",
      type: "flow",
      displayName: "Cool Flow",
      description: "A cool flow",
    });
    mockPackageById["@acme/cool-flow"] = { id: "@acme/cool-flow", orgId: "org-1" };

    const result = await forkPackage("org-1", "acme", "@other/cool-flow", "user-1");

    expect("code" in result).toBe(true);
    if ("code" in result) {
      expect(result.code).toBe("NAME_COLLISION");
    }
  });

  test("manifest.name updated to new scoped ID", async () => {
    setupSourcePackage({
      packageId: "@other/cool-flow",
      type: "flow",
      displayName: "Cool",
    });

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

  test("fork uses version manifest metadata (displayName, description)", async () => {
    setupSourcePackage({
      packageId: "@other/cool-flow",
      type: "flow",
      content: "# Cool flow prompt content",
      displayName: "Cool Flow Display",
      description: "A really cool flow",
    });

    await forkPackage("org-1", "acme", "@other/cool-flow", "user-42");

    expect(mockCreatedItems.length).toBe(1);
    const created = mockCreatedItems[0] as Record<string, unknown>;
    expect(created.name).toBe("Cool Flow Display");
    expect(created.description).toBe("A really cool flow");
    expect(created.content).toBe("# Cool flow prompt content");
    expect(created.createdBy).toBe("user-42");
  });

  test("fork creates a local published version", async () => {
    setupSourcePackage({
      packageId: "@other/cool-flow",
      type: "flow",
      version: "2.1.0",
    });

    await forkPackage("org-1", "acme", "@other/cool-flow", "user-1");

    expect(mockCreatedVersions.length).toBe(1);
    const ver = mockCreatedVersions[0] as {
      packageId: string;
      version: string;
      manifest: Record<string, unknown>;
    };
    expect(ver.packageId).toBe("@acme/cool-flow");
    expect(ver.version).toBe("2.1.0");
    expect(ver.manifest.name).toBe("@acme/cool-flow");
  });

  test("forked version manifest has updated name", async () => {
    setupSourcePackage({
      packageId: "@other/cool-flow",
      type: "flow",
    });

    await forkPackage("org-1", "acme", "@other/cool-flow", "user-1");

    expect(mockCreatedVersions.length).toBe(1);
    const ver = mockCreatedVersions[0] as { manifest: Record<string, unknown> };
    expect(ver.manifest.name).toBe("@acme/cool-flow");
    expect(ver.manifest.type).toBe("flow");
  });

  test("fork flow triggers syncFlowDepsJunctionTable", async () => {
    setupSourcePackage({
      packageId: "@other/cool-flow",
      type: "flow",
    });

    await forkPackage("org-1", "acme", "@other/cool-flow", "user-1");

    expect(mockSyncCalls.length).toBe(1);
    expect((mockSyncCalls[0] as unknown[])[0]).toBe("@acme/cool-flow");
    expect((mockSyncCalls[0] as unknown[])[1]).toBe("org-1");
  });

  test("fork skill does NOT trigger syncFlowDepsJunctionTable", async () => {
    setupSourcePackage({
      packageId: "@other/my-skill",
      type: "skill",
      content: "# skill content",
    });

    await forkPackage("org-1", "acme", "@other/my-skill", "user-1");

    expect(mockSyncCalls.length).toBe(0);
    expect(mockCreatedItems.length).toBe(1);
    const created = mockCreatedItems[0] as { type: string };
    expect(created.type).toBe("skill");
  });

  test("fork populates draft storage from version ZIP entries", async () => {
    setupSourcePackage({
      packageId: "@other/cool-flow",
      type: "flow",
      content: "# Cool flow prompt",
    });

    await forkPackage("org-1", "acme", "@other/cool-flow", "user-1");

    // Draft storage upload should have been called with files from the ZIP
    expect(mockUploadedFiles.length).toBe(1);
    const args = mockUploadedFiles[0] as unknown[];
    expect(args[0]).toBe("flows");
    expect(args[1]).toBe("org-1");
    expect(args[2]).toBe("@acme/cool-flow");

    const uploadedFiles = args[3] as Record<string, Uint8Array>;
    // Should contain the content file from the ZIP
    expect(uploadedFiles["prompt.md"]).toBeDefined();
    expect(new TextDecoder().decode(uploadedFiles["prompt.md"])).toBe("# Cool flow prompt");
    // Should contain the updated manifest
    expect(uploadedFiles["manifest.json"]).toBeDefined();
    const manifest = JSON.parse(new TextDecoder().decode(uploadedFiles["manifest.json"]));
    expect(manifest.name).toBe("@acme/cool-flow");
  });

  test("fork with custom name uses custom name instead of source name", async () => {
    setupSourcePackage({
      packageId: "@other/cool-flow",
      type: "flow",
      displayName: "Cool Flow",
      description: "A cool flow",
    });

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
    setupSourcePackage({
      packageId: "@other/cool-flow",
      type: "flow",
    });
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
