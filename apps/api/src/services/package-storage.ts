import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { zipArtifact, unzipArtifact, type Zippable } from "@appstrate/core/zip";
import { verifyArtifactIntegrity } from "@appstrate/core/download";
import * as storage from "@appstrate/db/storage";
import { logger } from "../lib/logger.ts";
import type { LoadedFlow } from "../types/index.ts";
import { getPackagesDir } from "./flow-service.ts";
import {
  isBuiltInSkill,
  isBuiltInExtension,
  getBuiltInSkillFiles,
  getBuiltInExtensionFile,
} from "./builtin-packages.ts";
import { parseScopedName } from "@appstrate/core/naming";

const BUCKET = "flow-packages";
const ZIP_COMPRESSION_LEVEL = 6;

// In-memory cache for built-in flow packages (created once, never mutated)
const builtInPackageCache = new Map<string, Buffer>();

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

/** Package a built-in flow directory into a ZIP buffer (cached in memory). */
async function getBuiltInPackageZip(packageId: string): Promise<Buffer> {
  const cached = builtInPackageCache.get(packageId);
  if (cached) return cached;

  const dir = getPackagesDir();
  if (!dir) throw new Error("DATA_DIR not configured — cannot package built-in flow");
  const flowPath = join(dir, packageId);
  const zipData = await createZipFromDirectory(flowPath);
  const buffer = Buffer.from(zipData);

  builtInPackageCache.set(packageId, buffer);
  return buffer;
}

/** Get the package ZIP for any flow (built-in or user). */
export async function getPackageZip(flow: LoadedFlow, orgId: string): Promise<Buffer | null> {
  if (flow.source === "built-in") {
    return getBuiltInPackageZip(flow.id);
  }

  return buildUserFlowZip(flow, orgId);
}

/** Build a user flow package ZIP on-the-fly from org packages + built-in content. */
async function buildUserFlowZip(flow: LoadedFlow, orgId: string): Promise<Buffer> {
  const { getFlowItemFiles, SKILL_CONFIG, EXTENSION_CONFIG } = await import("./package-items.ts");

  const entries: Zippable = {
    "manifest.json": new TextEncoder().encode(JSON.stringify(flow.manifest, null, 2)),
    "prompt.md": new TextEncoder().encode(flow.prompt),
  };

  // Fetch org skill files and extension files in parallel
  const [skillFiles, extFiles] = await Promise.all([
    getFlowItemFiles(flow.id, orgId, SKILL_CONFIG),
    getFlowItemFiles(flow.id, orgId, EXTENSION_CONFIG),
  ]);

  for (const [skillId, files] of skillFiles) {
    for (const [filePath, content] of Object.entries(files)) {
      entries[`skills/${skillId}/${filePath}`] = content;
    }
  }

  for (const [, files] of extFiles) {
    for (const [filePath, content] of Object.entries(files)) {
      entries[`extensions/${filePath}`] = content;
    }
  }

  // Add built-in skills and extensions referenced by the flow (parallel lookups)
  const builtInSkillPromises = flow.skills
    .filter((skill) => isBuiltInSkill(skill.id) && !skillFiles.has(skill.id))
    .map(async (skill) => {
      const files = await getBuiltInSkillFiles(skill.id);
      if (files) {
        for (const [filePath, content] of Object.entries(files)) {
          entries[`skills/${skill.id}/${filePath}`] = content;
        }
      }
    });

  const orgExtIds = new Set([...extFiles.keys()]);
  const builtInExtPromises = flow.extensions
    .filter((ext) => isBuiltInExtension(ext.id) && !orgExtIds.has(ext.id))
    .map(async (ext) => {
      const file = await getBuiltInExtensionFile(ext.id);
      if (file) {
        const slug = parseScopedName(ext.id)?.name ?? ext.id;
        entries[`extensions/${slug}.ts`] = file;
      }
    });

  await Promise.all([...builtInSkillPromises, ...builtInExtPromises]);

  return Buffer.from(zipArtifact(entries, ZIP_COMPRESSION_LEVEL));
}

/** Build a minimal ZIP with just manifest.json + prompt.md. */
export function buildMinimalZip(manifest: Record<string, unknown>, prompt: string): Buffer {
  const entries: Zippable = {
    "manifest.json": new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
    "prompt.md": new TextEncoder().encode(prompt),
  };
  return Buffer.from(zipArtifact(entries, ZIP_COMPRESSION_LEVEL));
}

/**
 * Unzip a buffer and normalize (strip __MACOSX, directory entries, and folder wrappers).
 * Returns a map of path → content as Uint8Array.
 */
export function unzipAndNormalize(zipBuffer: Buffer): Record<string, Uint8Array> {
  const { files, prefix } = unzipArtifact(new Uint8Array(zipBuffer));

  const result: Record<string, Uint8Array> = {};
  for (const [path, data] of Object.entries(files)) {
    // Filter out directory entries and __MACOSX resource forks
    if (path.endsWith("/") || path.startsWith("__MACOSX/")) continue;
    const stripped = prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path;
    if (stripped) result[stripped] = data;
  }
  return result;
}

/** Recursively read a directory into an fflate Zippable structure. */
async function createZipFromDirectory(dirPath: string): Promise<Uint8Array> {
  const entries: Zippable = {};
  await addDirectoryToZip(dirPath, "", entries);
  return zipArtifact(entries, ZIP_COMPRESSION_LEVEL);
}

async function addDirectoryToZip(
  basePath: string,
  prefix: string,
  entries: Zippable,
): Promise<void> {
  let items: string[];
  try {
    items = await readdir(basePath);
  } catch {
    return;
  }

  for (const item of items) {
    const fullPath = join(basePath, item);
    const zipPath = prefix ? `${prefix}/${item}` : item;
    const file = Bun.file(fullPath);

    const info = await file.stat().catch(() => null);
    if (!info) continue;

    if (info.isDirectory()) {
      await addDirectoryToZip(fullPath, zipPath, entries);
    } else {
      const content = await file.arrayBuffer();
      entries[zipPath] = new Uint8Array(content);
    }
  }
}
