// SPDX-License-Identifier: Apache-2.0

import { zipArtifact, unzipArtifact, type Zippable } from "@appstrate/core/zip";
import { verifyArtifactIntegrity } from "@appstrate/core/integrity";
import * as storage from "@appstrate/db/storage";
import { logger } from "../lib/logger.ts";
import type { LoadedPackage } from "../types/index.ts";
import {
  getPackageDepFiles,
  SKILL_CONFIG,
  TOOL_CONFIG,
  PROVIDER_CONFIG,
} from "./package-items/index.ts";

const BUCKET = "flow-packages";
const ZIP_COMPRESSION_LEVEL = 6;

/** Download a versioned package ZIP from Storage. Optionally verifies integrity. Returns null if not found. */
export async function downloadVersionZip(
  packageId: string,
  version: string,
  expectedIntegrity?: string | null,
): Promise<Buffer | null> {
  const path = `${packageId}/${version}.afps`;
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
  const path = `${packageId}/${version}.afps`;
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
  const path = `${packageId}/${version}.afps`;
  try {
    await storage.uploadFile(BUCKET, path, zipBuffer);
  } catch (error) {
    logger.error("Failed to upload agent package", {
      packageId,
      version,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

interface AgentPackageResult {
  zip: Buffer;
  toolDocs: Array<{ id: string; content: string }>;
}

/** Build an agent package ZIP on-the-fly and extract TOOL.md docs in a single pass. */
export async function buildAgentPackage(
  flow: LoadedPackage,
  orgId: string,
): Promise<AgentPackageResult> {
  const entries: Zippable = {
    "manifest.json": new TextEncoder().encode(JSON.stringify(flow.manifest, null, 2)),
    "prompt.md": new TextEncoder().encode(flow.prompt),
  };

  // Fetch skill, tool, and provider files in parallel
  const [skillFiles, toolFiles, providerFiles] = await Promise.all([
    getPackageDepFiles(flow.id, orgId, SKILL_CONFIG),
    getPackageDepFiles(flow.id, orgId, TOOL_CONFIG),
    getPackageDepFiles(flow.id, orgId, PROVIDER_CONFIG),
  ]);

  for (const [skillId, files] of skillFiles) {
    for (const [filePath, content] of Object.entries(files)) {
      entries[`skills/${skillId}/${filePath}`] = content;
    }
  }

  for (const [toolId, files] of toolFiles) {
    for (const [filePath, content] of Object.entries(files)) {
      entries[`tools/${toolId}/${filePath}`] = content;
    }
  }

  for (const [providerId, files] of providerFiles) {
    for (const [filePath, content] of Object.entries(files)) {
      entries[`providers/${providerId}/${filePath}`] = content;
    }
  }

  // Extract TOOL.md content from tool files (avoids a second S3 fetch)
  const toolDocs: Array<{ id: string; content: string }> = [];
  for (const [toolId, files] of toolFiles) {
    const md = files["TOOL.md"];
    if (md) {
      toolDocs.push({ id: toolId, content: new TextDecoder().decode(md) });
    }
  }

  return { zip: Buffer.from(zipArtifact(entries, ZIP_COMPRESSION_LEVEL)), toolDocs };
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
