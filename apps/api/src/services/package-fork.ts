// SPDX-License-Identifier: Apache-2.0

import { parseScopedName, isOwnedByOrg } from "@appstrate/core/naming";
import type { PackageType } from "@appstrate/core/validation";

import { zipArtifact } from "@appstrate/core/zip";
import {
  getOrgItem,
  getPackageById,
  createOrgItem,
  uploadPackageFiles,
  type PackageTypeConfig,
  CONFIG_BY_TYPE,
} from "./package-items/index.ts";

import { getLatestVersionId, createVersionAndUpload } from "./package-versions.ts";
import { downloadVersionZip, unzipAndNormalize } from "./package-storage.ts";
import { db } from "@appstrate/db/client";
import { packageVersions } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";
import { asRecord } from "../lib/safe-json.ts";

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

  const detectedType = await getPackageType(orgId, sourcePackageId);
  const cfg = detectedType ? CONFIG_BY_TYPE[detectedType] : undefined;
  if (!cfg) {
    // Try to find the package to get its type
    const raw = await getPackageById(sourcePackageId);
    if (!raw) return { code: "NOT_FOUND" };
    const typeCfg = CONFIG_BY_TYPE[raw.type as PackageType];
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

async function getPackageType(orgId: string, packageId: string): Promise<PackageType | null> {
  // Try each config type to find the package in the org context
  for (const [type, cfg] of Object.entries(CONFIG_BY_TYPE)) {
    const item = await getOrgItem(orgId, packageId, cfg);
    if (item) return type as PackageType;
  }
  return null;
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
  const versionManifest = asRecord(versionRow.manifest);
  const updatedManifest = { ...versionManifest, name: targetId };

  // Create the fork package (draft)
  const newPkg = await createOrgItem(
    orgId,
    {
      id: targetId,
      name:
        typeof versionManifest.displayName === "string" ? versionManifest.displayName : undefined,
      description:
        typeof versionManifest.description === "string" ? versionManifest.description : undefined,
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

  // Create a local published version
  await createVersionAndUpload({
    packageId: newPkg.id,
    version: versionRow.version,
    createdBy: userId ?? null,
    zipBuffer: newZipBuffer,
    manifest: updatedManifest,
  });

  return {
    packageId: newPkg.id,
    type: cfg.type,
    forkedFrom: sourcePackageId,
  };
}
