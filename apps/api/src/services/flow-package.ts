import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { zipSync, unzipSync, type Zippable } from "fflate";
import { supabase, ensureBucket } from "../lib/supabase.ts";
import { logger } from "../lib/logger.ts";
import type { LoadedFlow } from "../types/index.ts";
import { FLOWS_DIR } from "./flow-service.ts";

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

/** Delete all versions of a flow package from Storage. */
export async function deleteFlowPackage(flowId: string): Promise<void> {
  const { data: files } = await supabase.storage.from(BUCKET).list(flowId);
  if (!files || files.length === 0) return;

  const paths = files.map((f) => `${flowId}/${f.name}`);
  const { error } = await supabase.storage.from(BUCKET).remove(paths);
  if (error) {
    logger.warn("Failed to delete flow package files", { flowId, error: error.message });
  }
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
export async function getFlowPackage(flow: LoadedFlow): Promise<Buffer | null> {
  if (flow.source === "built-in") {
    return getBuiltInFlowPackage(flow.id);
  }

  // User flow: download from Storage
  return downloadFlowPackage(flow.id);
}

/**
 * Download the current ZIP, unzip (skipping directory entries), apply a transform, and rezip.
 * If `allowMissing` is true, starts from an empty Zippable when no ZIP exists in Storage.
 */
async function modifyPackage(
  flowId: string,
  transform: (entries: Zippable) => void,
  allowMissing = false,
): Promise<Buffer> {
  const existingZip = await downloadFlowPackage(flowId);

  const entries: Zippable = {};

  if (existingZip) {
    const files = unzipSync(new Uint8Array(existingZip));
    for (const [path, data] of Object.entries(files)) {
      if (path.endsWith("/")) continue;
      entries[path] = data;
    }
  } else if (!allowMissing) {
    throw new Error(`No package ZIP found in Storage for flow '${flowId}'`);
  }

  transform(entries);

  return Buffer.from(zipSync(entries, { level: ZIP_COMPRESSION_LEVEL }));
}

/**
 * Download the current ZIP for a user flow from Storage, replace manifest.json + prompt.md,
 * and return the new ZIP buffer. If no ZIP exists in Storage, builds a minimal ZIP.
 */
export async function rebuildPackageWithNewManifestAndPrompt(
  flowId: string,
  manifest: Record<string, unknown>,
  prompt: string,
): Promise<Buffer> {
  return modifyPackage(
    flowId,
    (entries) => {
      entries["manifest.json"] = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
      entries["prompt.md"] = new TextEncoder().encode(prompt);
    },
    true,
  );
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
 * Download the current ZIP for a user flow, extract the uploaded ZIP contents,
 * and merge them under a target prefix. Throws if no package ZIP exists in Storage.
 * Automatically strips a single-directory wrapper from the uploaded ZIP.
 */
export async function addExtractedZipToPackage(
  flowId: string,
  targetPrefix: string,
  uploadedZip: Buffer,
): Promise<Buffer> {
  return modifyPackage(flowId, (entries) => {
    const rawFiles = unzipSync(new Uint8Array(uploadedZip));
    const normalizedFiles = stripZipDirectoryWrapper(rawFiles);
    for (const [path, data] of Object.entries(normalizedFiles)) {
      entries[`${targetPrefix}${path}`] = data;
    }
  });
}

/**
 * Download the current ZIP for a user flow, add/replace a single file at the given path,
 * and return the new ZIP buffer. Throws if no ZIP exists in Storage.
 */
export async function addFileToPackage(
  flowId: string,
  filePath: string,
  fileContent: Uint8Array,
): Promise<Buffer> {
  return modifyPackage(flowId, (entries) => {
    entries[filePath] = fileContent;
  });
}

/**
 * Download the current ZIP for a user flow, remove all files matching a path prefix,
 * and return the new ZIP buffer. Throws if no ZIP exists in Storage.
 */
export async function removeFilesFromPackage(flowId: string, pathPrefix: string): Promise<Buffer> {
  return modifyPackage(flowId, (entries) => {
    for (const path of Object.keys(entries)) {
      if (path.startsWith(pathPrefix)) delete entries[path];
    }
  });
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
