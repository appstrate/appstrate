import { zipArtifact, unzipArtifact } from "@appstrate/validation/zip";
import * as storage from "@appstrate/db/storage";
import { logger } from "../../lib/logger.ts";
import { LIBRARY_BUCKET } from "./config.ts";

// ─────────────────────────────────────────────
// Library package Storage (full ZIP)
// ─────────────────────────────────────────────

/** Upload a library item's full normalized files to Storage. */
export async function uploadLibraryPackage(
  type: "skills" | "extensions",
  orgId: string,
  itemId: string,
  normalizedFiles: Record<string, Uint8Array>,
): Promise<void> {
  const zip = zipArtifact(normalizedFiles, 6);
  const path = `${orgId}/${type}/${itemId}.zip`;
  try {
    await storage.uploadFile(LIBRARY_BUCKET, path, zip);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("Failed to upload library package", { type, orgId, itemId, error: message });
    throw err;
  }
}

/** Download a library item's full files from Storage. Returns normalized file map or null. */
export async function downloadLibraryPackage(
  type: "skills" | "extensions",
  orgId: string,
  itemId: string,
): Promise<Record<string, Uint8Array> | null> {
  const path = `${orgId}/${type}/${itemId}.zip`;
  const data = await storage.downloadFile(LIBRARY_BUCKET, path);
  if (!data) {
    logger.warn("Failed to download library package", { type, orgId, itemId });
    return null;
  }
  return unzipArtifact(new Uint8Array(data)).files;
}

/** Delete a library item's package from Storage. */
export async function deleteLibraryPackage(
  type: "skills" | "extensions",
  orgId: string,
  itemId: string,
): Promise<void> {
  const path = `${orgId}/${type}/${itemId}.zip`;
  await storage.deleteFile(LIBRARY_BUCKET, path);
}
