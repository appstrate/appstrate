import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { zipSync, unzipSync, type Zippable } from "fflate";
import { supabase, ensureBucket } from "../lib/supabase.ts";
import { logger } from "../lib/logger.ts";
import type { LoadedFlow } from "../types/index.ts";
import { FLOWS_DIR } from "./flow-service.ts";
import {
  isBuiltInSkill,
  isBuiltInExtension,
  getBuiltInSkillFiles,
  getBuiltInExtensionFile,
} from "./builtin-library.ts";

const BUCKET = "flow-packages";
const ZIP_COMPRESSION_LEVEL = 6;

// In-memory cache for built-in flow packages (created once, never mutated)
const builtInPackageCache = new Map<string, Buffer>();

/** Ensure the flow-packages Storage bucket exists. Call once at boot. */
export const ensureStorageBucket = () => ensureBucket(BUCKET);

/** Upload a flow package ZIP to Storage. */
export async function uploadFlowPackage(
  flowId: string,
  versionNumber: number,
  zipBuffer: Buffer,
): Promise<void> {
  const path = `${flowId}/${versionNumber}.zip`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, zipBuffer, {
    contentType: "application/zip",
    upsert: true,
  });
  if (error) {
    logger.error("Failed to upload flow package", { flowId, versionNumber, error: error.message });
    throw error;
  }
}

/** Download a specific version of a flow package from Storage. If no version, fetches the latest. */
export async function downloadFlowPackage(
  flowId: string,
  versionNumber?: number,
): Promise<Buffer | null> {
  let path: string;

  if (versionNumber !== undefined) {
    path = `${flowId}/${versionNumber}.zip`;
  } else {
    // Find the latest version by listing files (sort by created_at for correct ordering)
    const { data: files } = await supabase.storage.from(BUCKET).list(flowId, {
      sortBy: { column: "created_at", order: "desc" },
      limit: 1,
    });
    if (!files || files.length === 0) return null;
    path = `${flowId}/${files[0]!.name}`;
  }

  const { data, error } = await supabase.storage.from(BUCKET).download(path);
  if (error) {
    logger.warn("Failed to download flow package", { path, error: error.message });
    return null;
  }

  return Buffer.from(await data.arrayBuffer());
}

/** Package a built-in flow directory into a ZIP buffer (cached in memory). */
async function getBuiltInFlowPackage(flowId: string): Promise<Buffer> {
  const cached = builtInPackageCache.get(flowId);
  if (cached) return cached;

  const flowPath = join(FLOWS_DIR, flowId);
  const zipData = await createZipFromDirectory(flowPath);
  const buffer = Buffer.from(zipData);

  builtInPackageCache.set(flowId, buffer);
  return buffer;
}

/** Get the flow package for any flow (built-in or user). */
export async function getFlowPackage(flow: LoadedFlow, orgId?: string): Promise<Buffer | null> {
  if (flow.source === "built-in") {
    return getBuiltInFlowPackage(flow.id);
  }

  // User flow: build ZIP on-the-fly from org library
  if (orgId) {
    return buildUserFlowPackage(flow, orgId);
  }

  // Fallback: download from Storage (legacy)
  return downloadFlowPackage(flow.id);
}

/** Build a user flow package ZIP on-the-fly from org library + built-in content. */
async function buildUserFlowPackage(flow: LoadedFlow, orgId: string): Promise<Buffer> {
  const { getFlowSkillFiles, getFlowExtensionFiles } = await import("./library.ts");

  const entries: Zippable = {
    "manifest.json": new TextEncoder().encode(JSON.stringify(flow.manifest, null, 2)),
    "prompt.md": new TextEncoder().encode(flow.prompt),
  };

  // Fetch org skill files from library storage
  const skillFiles = await getFlowSkillFiles(flow.id, orgId);
  for (const [skillId, files] of skillFiles) {
    for (const [filePath, content] of Object.entries(files)) {
      entries[`skills/${skillId}/${filePath}`] = content;
    }
  }

  // Add built-in skills referenced by the flow
  for (const skill of flow.skills) {
    if (isBuiltInSkill(skill.id) && !skillFiles.has(skill.id)) {
      const files = await getBuiltInSkillFiles(skill.id);
      if (files) {
        for (const [filePath, content] of Object.entries(files)) {
          entries[`skills/${skill.id}/${filePath}`] = content;
        }
      }
    }
  }

  // Fetch org extension files from library storage
  const extFiles = await getFlowExtensionFiles(flow.id, orgId);
  for (const [, files] of extFiles) {
    for (const [filePath, content] of Object.entries(files)) {
      entries[`extensions/${filePath}`] = content;
    }
  }

  // Add built-in extensions referenced by the flow
  const orgExtIds = new Set([...extFiles.keys()]);
  for (const ext of flow.extensions) {
    if (isBuiltInExtension(ext.id) && !orgExtIds.has(ext.id)) {
      const file = await getBuiltInExtensionFile(ext.id);
      if (file) {
        entries[`extensions/${ext.id}.ts`] = file;
      }
    }
  }

  return Buffer.from(zipSync(entries, { level: ZIP_COMPRESSION_LEVEL }));
}

/** Build a minimal ZIP with just manifest.json + prompt.md. */
export function buildMinimalZip(manifest: Record<string, unknown>, prompt: string): Buffer {
  const entries: Zippable = {
    "manifest.json": new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
    "prompt.md": new TextEncoder().encode(prompt),
  };
  return Buffer.from(zipSync(entries, { level: ZIP_COMPRESSION_LEVEL }));
}

/**
 * Strip macOS resource fork entries (__MACOSX/) and a common single-directory wrapper from ZIP entries.
 * e.g. if all files are under "my-skill/", strip that prefix so "my-skill/SKILL.md" → "SKILL.md".
 */
export function stripZipDirectoryWrapper(
  files: Record<string, Uint8Array>,
): Record<string, Uint8Array> {
  // Filter out directory entries and __MACOSX resource forks
  const filePaths = Object.keys(files).filter(
    (k) => !k.endsWith("/") && !k.startsWith("__MACOSX/"),
  );
  if (filePaths.length === 0) return {};

  // Check if all file paths share a common single-directory prefix (e.g. "folder/")
  const firstSlash = filePaths[0]!.indexOf("/");
  const hasWrapper = firstSlash !== -1;
  const prefix = hasWrapper ? filePaths[0]!.slice(0, firstSlash + 1) : "";
  const allSharePrefix = hasWrapper && filePaths.every((p) => p.startsWith(prefix));

  // Build filtered result, optionally stripping the shared prefix
  const result: Record<string, Uint8Array> = {};
  for (const p of filePaths) {
    result[allSharePrefix ? p.slice(prefix.length) : p] = files[p]!;
  }
  return result;
}

/**
 * Unzip a buffer and normalize (strip __MACOSX, directory wrappers).
 * Returns a map of path → content as Uint8Array.
 */
export function unzipAndNormalize(zipBuffer: Buffer): Record<string, Uint8Array> {
  const rawFiles = unzipSync(new Uint8Array(zipBuffer));
  return stripZipDirectoryWrapper(rawFiles);
}

/** Recursively read a directory into an fflate Zippable structure. */
async function createZipFromDirectory(dirPath: string): Promise<Uint8Array> {
  const entries: Zippable = {};
  await addDirectoryToZip(dirPath, "", entries);
  return zipSync(entries, { level: ZIP_COMPRESSION_LEVEL });
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

    const info = await stat(fullPath).catch(() => null);
    if (!info) continue;

    if (info.isDirectory()) {
      await addDirectoryToZip(fullPath, zipPath, entries);
    } else {
      const content = await Bun.file(fullPath).arrayBuffer();
      entries[zipPath] = new Uint8Array(content);
    }
  }
}
