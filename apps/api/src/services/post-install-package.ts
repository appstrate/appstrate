import { logger } from "../lib/logger.ts";
import { db } from "../lib/db.ts";
import { providerCredentials } from "@appstrate/db/schema";
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
} from "./package-items.ts";
import { isValidVersion } from "@appstrate/core/semver";
import type { PackageType } from "./package-items/config.ts";

/** Parse manifest.json from normalized ZIP files. Throws if not found. */
function parseManifestFromFiles(files: Record<string, Uint8Array>): Record<string, unknown> {
  const data = files["manifest.json"];
  if (!data) {
    throw new Error(
      `manifest.json not found in files dict. Available keys: ${Object.keys(files).join(", ")}`,
    );
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(data));
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("manifest.json is not a valid JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error("manifest.json is not valid JSON", { cause: err });
    }
    throw err;
  }
}

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
 * Creates a version in packageVersions for ALL types (flow, skill, tool, provider),
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

  if (packageType === "flow" && Object.keys(files).length > 0) {
    await uploadPackageFiles("flows", orgId, packageId, files);
  }

  if (packageType === "provider") {
    // UPSERT providerCredentials (providerId, orgId) — empty, admin configures later
    await db
      .insert(providerCredentials)
      .values({ providerId: packageId, orgId })
      .onConflictDoNothing();
  }

  await createVersion(manifest);
}
