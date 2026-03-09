import { parseScopedName, isOwnedByOrg } from "@appstrate/core/naming";
import type { Manifest } from "@appstrate/core/validation";
import { zipArtifact, type Zippable } from "@appstrate/core/zip";
import {
  getOrgItem,
  getPackageById,
  createOrgItem,
  syncFlowDepsJunctionTable,
  uploadPackageFiles,
  type PackageTypeConfig,
  FLOW_CONFIG,
  SKILL_CONFIG,
  EXTENSION_CONFIG,
  PROVIDER_CONFIG,
} from "./package-items.ts";
import { extractDepsFromManifest } from "../lib/manifest-utils.ts";
import { downloadPackageFiles } from "./package-items/storage.ts";
import { getLatestVersionId, createVersionAndUpload } from "./package-versions-impl.ts";
import { downloadVersionZip, unzipAndNormalize } from "./package-storage.ts";
import { db } from "../lib/db.ts";
import { packageVersions } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";

const TYPE_TO_CONFIG: Record<string, PackageTypeConfig> = {
  flow: FLOW_CONFIG,
  skill: SKILL_CONFIG,
  extension: EXTENSION_CONFIG,
  provider: PROVIDER_CONFIG,
};

export interface ForkResult {
  packageId: string;
  type: string;
  forkedFrom: string;
}

export type ForkError =
  | { code: "ALREADY_OWNED" }
  | { code: "NOT_FOUND" }
  | { code: "NAME_COLLISION"; existingId: string }
  | { code: "UNKNOWN_TYPE"; type: string }
  | { code: "NO_PUBLISHED_VERSION" };

export async function forkPackage(
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

  const cfg = TYPE_TO_CONFIG[await getPackageType(orgId, sourcePackageId)];
  if (!cfg) {
    // Try to find the package to get its type
    const raw = await getPackageById(sourcePackageId);
    if (!raw) return { code: "NOT_FOUND" };
    const typeCfg = TYPE_TO_CONFIG[raw.type];
    if (!typeCfg) return { code: "UNKNOWN_TYPE", type: raw.type };
    return forkWithConfig(
      orgId,
      orgSlug,
      sourcePackageId,
      customName ?? parsed.name,
      typeCfg,
      userId,
    );
  }

  return forkWithConfig(orgId, orgSlug, sourcePackageId, customName ?? parsed.name, cfg, userId);
}

async function getPackageType(orgId: string, packageId: string): Promise<string> {
  // Try each config type to find the package in the org context
  for (const [type, cfg] of Object.entries(TYPE_TO_CONFIG)) {
    const item = await getOrgItem(orgId, packageId, cfg);
    if (item) return type;
  }
  return "";
}

async function forkWithConfig(
  orgId: string,
  orgSlug: string,
  sourcePackageId: string,
  sourceName: string,
  cfg: PackageTypeConfig,
  userId?: string,
): Promise<ForkResult | ForkError> {
  // Resolve latest published version of the source
  const latestVersionId = await getLatestVersionId(sourcePackageId);
  if (!latestVersionId) return { code: "NO_PUBLISHED_VERSION" };

  const [versionRow] = await db
    .select({
      version: packageVersions.version,
      manifest: packageVersions.manifest,
      integrity: packageVersions.integrity,
    })
    .from(packageVersions)
    .where(eq(packageVersions.id, latestVersionId))
    .limit(1);

  if (!versionRow) return { code: "NO_PUBLISHED_VERSION" };

  // Download the source version ZIP
  const sourceZip = await downloadVersionZip(sourcePackageId, versionRow.version);
  if (!sourceZip) return { code: "NO_PUBLISHED_VERSION" };

  // Extract content from the ZIP
  const zipEntries = unzipAndNormalize(sourceZip);
  const decoder = new TextDecoder();
  const content = zipEntries["prompt.md"]
    ? decoder.decode(zipEntries["prompt.md"])
    : zipEntries["SKILL.md"]
      ? decoder.decode(zipEntries["SKILL.md"])
      : "";

  // Build target packageId
  const targetId = `@${orgSlug}/${sourceName}`;

  // Check for collision
  const existing = await getPackageById(targetId);
  if (existing) return { code: "NAME_COLLISION", existingId: targetId };

  // Build manifest from the published version snapshot, update name
  const versionManifest = (versionRow.manifest ?? {}) as Record<string, unknown>;
  const updatedManifest = { ...versionManifest, name: targetId };

  // Create the fork package (draft)
  const newPkg = await createOrgItem(
    orgId,
    orgSlug,
    {
      id: sourceName,
      name: (versionManifest.displayName as string) ?? undefined,
      description: (versionManifest.description as string) ?? undefined,
      content,
      createdBy: userId,
    },
    cfg,
    updatedManifest,
    sourcePackageId,
  );

  // Copy storage files from the version ZIP (not from draft storage)
  const files = await downloadPackageFiles(cfg.storageFolder, orgId, sourcePackageId);
  if (files && Object.keys(files).length > 0) {
    await uploadPackageFiles(cfg.storageFolder, orgId, newPkg.id, files);
  }

  // Rebuild ZIP with updated manifest for the local version
  const newZipEntries: Zippable = {};
  for (const [path, data] of Object.entries(zipEntries)) {
    if (path === "manifest.json") continue; // Replace with updated manifest
    newZipEntries[path] = data;
  }
  newZipEntries["manifest.json"] = new TextEncoder().encode(
    JSON.stringify(updatedManifest, null, 2),
  );
  const newZipBuffer = Buffer.from(zipArtifact(newZipEntries, 6));

  // Create a local published version
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
    const manifest = updatedManifest as Partial<Manifest>;
    const { skillIds, extensionIds, providerIds } = extractDepsFromManifest(manifest);
    await syncFlowDepsJunctionTable(newPkg.id, orgId, skillIds, extensionIds, providerIds);
  }

  return {
    packageId: newPkg.id,
    type: cfg.type,
    forkedFrom: sourcePackageId,
  };
}
