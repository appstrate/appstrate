import { zipArtifact, unzipArtifact } from "@appstrate/core/zip";
import * as storage from "@appstrate/db/storage";
import { logger } from "../../lib/logger.ts";
import { PACKAGE_ITEMS_BUCKET } from "./config.ts";

// ─────────────────────────────────────────────
// Package item Storage (full ZIP)
// ─────────────────────────────────────────────

/** Upload a package item's full normalized files to Storage. */
export async function uploadPackageFiles(
  type: "skills" | "extensions",
  orgId: string,
  itemId: string,
  normalizedFiles: Record<string, Uint8Array>,
): Promise<void> {
  const zip = zipArtifact(normalizedFiles, 6);
  const path = `${orgId}/${type}/${itemId}.zip`;
  try {
    await storage.uploadFile(PACKAGE_ITEMS_BUCKET, path, zip);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("Failed to upload package files", { type, orgId, itemId, error: message });
    throw err;
  }
}

/** Download a package item's full files from Storage. Returns normalized file map or null. */
export async function downloadPackageFiles(
  type: "skills" | "extensions",
  orgId: string,
  itemId: string,
): Promise<Record<string, Uint8Array> | null> {
  const path = `${orgId}/${type}/${itemId}.zip`;
  const data = await storage.downloadFile(PACKAGE_ITEMS_BUCKET, path);
  if (!data) {
    logger.warn("Failed to download package files", { type, orgId, itemId });
    return null;
  }
  return unzipArtifact(new Uint8Array(data));
}

/** Delete a package item's files from Storage. */
export async function deletePackageFiles(
  type: "skills" | "extensions",
  orgId: string,
  itemId: string,
): Promise<void> {
  const path = `${orgId}/${type}/${itemId}.zip`;
  await storage.deleteFile(PACKAGE_ITEMS_BUCKET, path);
}
