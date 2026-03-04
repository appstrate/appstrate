import { extractSkillMeta } from "@appstrate/core/validation";
import { logger } from "../lib/logger.ts";
import { createVersionAndUpload, getNextVersion } from "./package-versions.ts";
import {
  upsertOrgItem,
  uploadPackageFiles,
  SKILL_CONFIG,
  EXTENSION_CONFIG,
} from "./package-items.ts";
import { isValidVersion } from "@appstrate/core/semver";

/** Parse manifest.json from normalized ZIP files if present. */
function parseManifestFromFiles(
  files: Record<string, Uint8Array>,
): Record<string, unknown> | undefined {
  const data = files["manifest.json"];
  if (!data) return undefined;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(data));
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Run per-type post-install side-effects after a package is saved to the DB.
 * Creates a version in packageVersions for ALL types (flow, skill, extension),
 * handles skill/extension upsert + storage.
 */
export async function postInstallPackage(params: {
  packageType: "flow" | "skill" | "extension";
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
  const manifestOrEmpty = manifest ?? {};
  const manifestVersion = manifestOrEmpty.version as string | undefined;

  // Determine version: explicit override > manifest version > auto-bump
  const version =
    params.version ??
    (manifestVersion && isValidVersion(manifestVersion)
      ? manifestVersion
      : await getNextVersion(packageId));

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

  switch (packageType) {
    case "flow": {
      await createVersion(manifestOrEmpty);
      break;
    }
    case "skill": {
      const skillMeta = extractSkillMeta(content);
      await upsertOrgItem(
        orgId,
        null,
        {
          id: packageId,
          name: skillMeta.name || undefined,
          description: skillMeta.description || undefined,
          content,
          createdBy: userId,
        },
        SKILL_CONFIG,
        manifest,
      );
      await uploadPackageFiles("skills", orgId, packageId, files);

      // Create version for skill too
      await createVersion(manifest ?? manifestOrEmpty);
      break;
    }
    case "extension": {
      await upsertOrgItem(
        orgId,
        null,
        { id: packageId, content, createdBy: userId },
        EXTENSION_CONFIG,
        manifest,
      );
      await uploadPackageFiles("extensions", orgId, packageId, files);

      // Create version for extension too
      await createVersion(manifest ?? manifestOrEmpty);
      break;
    }
  }
}
