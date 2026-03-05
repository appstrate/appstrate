import { extractSkillMeta } from "@appstrate/core/validation";
import { logger } from "../lib/logger.ts";
import { createVersionAndUpload } from "./package-versions.ts";
import {
  upsertOrgItem,
  uploadPackageFiles,
  SKILL_CONFIG,
  EXTENSION_CONFIG,
} from "./package-items.ts";
import { isValidVersion } from "@appstrate/core/semver";

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

  switch (packageType) {
    case "flow": {
      await createVersion(manifest);
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
      await createVersion(manifest);
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
      await createVersion(manifest);
      break;
    }
  }
}
