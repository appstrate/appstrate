import { extractSkillMeta } from "@appstrate/validation";
import { logger } from "../lib/logger.ts";
import { createVersionAndUpload } from "./package-versions.ts";
import { upsertOrgItem, uploadLibraryPackage, SKILL_CONFIG, EXTENSION_CONFIG } from "./library.ts";

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
      const skillMeta = extractSkillMeta(content);
      await upsertOrgItem(
        orgId,
        {
          id: packageId,
          name: skillMeta.name || undefined,
          description: skillMeta.description || undefined,
          content,
          createdBy: userId,
        },
        SKILL_CONFIG,
      );
      await uploadLibraryPackage("skills", orgId, packageId, files);
      break;
    }
    case "extension": {
      await upsertOrgItem(orgId, { id: packageId, content, createdBy: userId }, EXTENSION_CONFIG);
      await uploadLibraryPackage("extensions", orgId, packageId, files);
      break;
    }
  }
}
