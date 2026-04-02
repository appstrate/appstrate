// SPDX-License-Identifier: Apache-2.0

import { logger } from "../lib/logger.ts";
import { parseManifestFromFiles } from "../lib/manifest-parser.ts";
import { createVersionAndUpload } from "./package-versions.ts";
import {
  createOrgItem,
  updateOrgItem,
  getOrgItem,
  uploadPackageFiles,
  SKILL_CONFIG,
  TOOL_CONFIG,
  type PackageTypeConfig,
  type CreateItemInput,
} from "./package-items/index.ts";
import { isValidVersion } from "@appstrate/core/semver";
import type { PackageType } from "./package-items/config.ts";

/** Insert or update a skill/tool during post-install. */
async function upsertItem(
  orgId: string,
  packageId: string,
  item: CreateItemInput,
  cfg: PackageTypeConfig,
  manifest: Record<string, unknown>,
): Promise<void> {
  const existing = await getOrgItem(orgId, packageId, cfg);
  if (existing && existing.lockVersion != null) {
    // Re-install: update existing package
    await updateOrgItem(packageId, { manifest, content: item.content }, existing.lockVersion);
  } else {
    await createOrgItem(orgId, item, cfg, manifest);
  }
}

/**
 * Run per-type post-install side-effects after a package is saved to the DB.
 * Creates a version in packageVersions for ALL types (agent, skill, tool, provider),
 * handles skill/tool upsert + storage.
 */
export async function postInstallPackage(params: {
  packageType: PackageType;
  packageId: string;
  orgId: string;
  userId: string;
  content: string;
  files: Record<string, Uint8Array>;
  zipBuffer: Buffer;
  /** Override version instead of auto-detecting from manifest or auto-bumping. */
  version?: string;
}): Promise<void> {
  const { packageType, packageId, orgId, userId, content, files, zipBuffer } = params;

  const manifest = parseManifestFromFiles(files);
  const manifestVersion = manifest.version as string | undefined;

  // Determine version: explicit override > manifest version > error
  const rawVersion = params.version ?? manifestVersion;
  if (!rawVersion || !isValidVersion(rawVersion)) {
    throw new Error(`Package ${packageId}: missing or invalid version in manifest`);
  }
  const version: string = rawVersion;

  /** Create a version snapshot (non-fatal on error). Deps handled by createVersionAndUpload. */
  async function createVersion(versionManifest: Record<string, unknown>): Promise<void> {
    try {
      await createVersionAndUpload({
        packageId,
        version,
        orgId,
        createdBy: userId,
        zipBuffer,
        manifest: versionManifest,
      });
    } catch (err) {
      logger.error("Failed to create package version", {
        packageId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (packageType === "skill" || packageType === "tool") {
    const cfg = packageType === "skill" ? SKILL_CONFIG : TOOL_CONFIG;
    const item: CreateItemInput = { id: packageId, content, createdBy: userId };
    await upsertItem(orgId, packageId, item, cfg, manifest);
    await uploadPackageFiles(cfg.storageFolder, orgId, packageId, files);
  }

  if (packageType === "provider" && files["PROVIDER.md"]) {
    await uploadPackageFiles("providers", orgId, packageId, files);
  }

  if (packageType === "agent" && Object.keys(files).length > 0) {
    await uploadPackageFiles("agents", orgId, packageId, files);
  }

  await createVersion(manifest);
}
