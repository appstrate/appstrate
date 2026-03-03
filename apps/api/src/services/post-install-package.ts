import { extractSkillMeta } from "@appstrate/core/validation";
import { logger } from "../lib/logger.ts";
import { createVersionAndUpload } from "./package-versions.ts";
import { upsertOrgItem, uploadLibraryPackage, SKILL_CONFIG, EXTENSION_CONFIG } from "./library.ts";

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
 * Handles version creation (flow), skill upsert + storage, extension upsert + storage.
 *
 * Separated from library.ts CRUD to keep orchestration and data-access concerns apart.
 */
export async function postInstallPackage(params: {
  packageType: "flow" | "skill" | "extension";
  packageId: string;
  orgId: string;
  userId: string;
  content: string;
  files: Record<string, Uint8Array>;
  zipBuffer: Buffer;
}): Promise<void> {
  const { packageType, packageId, orgId, userId, content, files, zipBuffer } = params;

  switch (packageType) {
    case "flow": {
      try {
        await createVersionAndUpload(packageId, userId, zipBuffer);
      } catch (err) {
        logger.error("Failed to create version for flow", {
          packageId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      break;
    }
    case "skill": {
      const zipManifest = parseManifestFromFiles(files);
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
        zipManifest,
      );
      await uploadLibraryPackage("skills", orgId, packageId, files);
      break;
    }
    case "extension": {
      const zipManifest = parseManifestFromFiles(files);
      await upsertOrgItem(
        orgId,
        null,
        { id: packageId, content, createdBy: userId },
        EXTENSION_CONFIG,
        zipManifest,
      );
      await uploadLibraryPackage("extensions", orgId, packageId, files);
      break;
    }
  }
}
