import { zipArtifact, unzipArtifact, type Zippable } from "@appstrate/core/zip";
import { verifyArtifactIntegrity } from "@appstrate/core/download";
import * as storage from "@appstrate/db/storage";
import { logger } from "../lib/logger.ts";
import type { LoadedFlow } from "../types/index.ts";

const BUCKET = "flow-packages";
const ZIP_COMPRESSION_LEVEL = 6;

/** Ensure the flow-packages Storage bucket exists. Call once at boot. */
export const ensureStorageBucket = () => storage.ensureBucket(BUCKET);

/** Download a versioned package ZIP from Storage. Optionally verifies integrity. Returns null if not found. */
export async function downloadVersionZip(
  packageId: string,
  version: string,
  expectedIntegrity?: string | null,
): Promise<Buffer | null> {
  const path = `${packageId}/${version}.zip`;
  const data = await storage.downloadFile(BUCKET, path);
  if (!data) return null;

  if (expectedIntegrity) {
    const result = verifyArtifactIntegrity(new Uint8Array(data), expectedIntegrity);
    if (!result.valid) {
      logger.error("Integrity mismatch on version download", {
        packageId,
        version,
        expected: expectedIntegrity,
        computed: result.computed,
      });
      throw new Error(`Integrity check failed for ${packageId}@${version}`);
    }
  }

  return Buffer.from(data);
}

/** Delete a versioned package ZIP from Storage. Swallows errors (best-effort cleanup). */
export async function deleteVersionZip(packageId: string, version: string): Promise<void> {
  const path = `${packageId}/${version}.zip`;
  try {
    await storage.deleteFile(BUCKET, path);
  } catch (error) {
    logger.warn("Failed to delete version ZIP (best-effort)", {
      packageId,
      version,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Upload a package ZIP to Storage. */
export async function uploadPackageZip(
  packageId: string,
  version: string,
  zipBuffer: Buffer,
): Promise<void> {
  const path = `${packageId}/${version}.zip`;
  try {
    await storage.uploadFile(BUCKET, path, zipBuffer);
  } catch (error) {
    logger.error("Failed to upload flow package", {
      packageId,
      version,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/** Get the package ZIP for any flow (system or user). */
export async function getPackageZip(flow: LoadedFlow, orgId: string): Promise<Buffer | null> {
  return buildUserFlowZip(flow, orgId);
}

/** Build a flow package ZIP on-the-fly from DB-backed packages. */
async function buildUserFlowZip(flow: LoadedFlow, orgId: string): Promise<Buffer> {
  const { getFlowItemFiles, SKILL_CONFIG, TOOL_CONFIG } = await import("./package-items.ts");

  const entries: Zippable = {
    "manifest.json": new TextEncoder().encode(JSON.stringify(flow.manifest, null, 2)),
    "prompt.md": new TextEncoder().encode(flow.prompt),
  };

  // Fetch skill files and tool files in parallel
  const [skillFiles, toolFiles] = await Promise.all([
    getFlowItemFiles(flow.id, orgId, SKILL_CONFIG),
    getFlowItemFiles(flow.id, orgId, TOOL_CONFIG),
  ]);

  for (const [skillId, files] of skillFiles) {
    for (const [filePath, content] of Object.entries(files)) {
      entries[`skills/${skillId}/${filePath}`] = content;
    }
  }

  for (const [, files] of toolFiles) {
    for (const [filePath, content] of Object.entries(files)) {
      entries[`tools/${filePath}`] = content;
    }
  }

  return Buffer.from(zipArtifact(entries, ZIP_COMPRESSION_LEVEL));
}

/** Build a minimal ZIP with just manifest.json + a content file (default: prompt.md). */
export function buildMinimalZip(
  manifest: Record<string, unknown>,
  content: string,
  contentFileName = "prompt.md",
): Buffer {
  const entries: Zippable = {
    "manifest.json": new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
    [contentFileName]: new TextEncoder().encode(content),
  };
  return Buffer.from(zipArtifact(entries, ZIP_COMPRESSION_LEVEL));
}

/**
 * Unzip a buffer and normalize (strip __MACOSX, directory entries).
 * Returns a map of path → content as Uint8Array.
 */
export function unzipAndNormalize(zipBuffer: Buffer): Record<string, Uint8Array> {
  return unzipArtifact(new Uint8Array(zipBuffer));
}
