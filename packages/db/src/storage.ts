import { join } from "node:path";
import { mkdir, rm, readdir, stat } from "node:fs/promises";
import { getEnv } from "@appstrate/env";

const STORAGE_DIR = getEnv().STORAGE_DIR || join(process.cwd(), "data", "storage");

/**
 * Ensure a bucket directory exists.
 */
export async function ensureBucket(bucket: string): Promise<void> {
  await mkdir(join(STORAGE_DIR, bucket), { recursive: true });
}

/**
 * Upload a file to a bucket.
 */
export async function uploadFile(
  bucket: string,
  path: string,
  data: Uint8Array | Buffer,
): Promise<string> {
  const fullDir = join(STORAGE_DIR, bucket, ...path.split("/").slice(0, -1));
  await mkdir(fullDir, { recursive: true });
  const fullPath = join(STORAGE_DIR, bucket, path);
  await Bun.write(fullPath, data);
  return fullPath;
}

/**
 * Download a file from a bucket. Returns null if not found.
 */
export async function downloadFile(bucket: string, path: string): Promise<Uint8Array | null> {
  const file = Bun.file(join(STORAGE_DIR, bucket, path));
  if (!(await file.exists())) return null;
  return new Uint8Array(await file.arrayBuffer());
}

/**
 * Delete a file from a bucket.
 */
export async function deleteFile(bucket: string, path: string): Promise<void> {
  await rm(join(STORAGE_DIR, bucket, path), { force: true });
}

/**
 * List files in a bucket under a prefix.
 */
export async function listFiles(bucket: string, prefix = ""): Promise<string[]> {
  const dir = join(STORAGE_DIR, bucket, prefix);
  try {
    return await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/**
 * Delete all files under a prefix in a bucket.
 */
export async function deletePrefix(bucket: string, prefix: string): Promise<void> {
  const dir = join(STORAGE_DIR, bucket, prefix);
  await rm(dir, { recursive: true, force: true });
}

/**
 * Get file info (size, modified date). Returns null if not found.
 */
export async function getFileInfo(
  bucket: string,
  path: string,
): Promise<{ size: number; modified: Date } | null> {
  try {
    const info = await stat(join(STORAGE_DIR, bucket, path));
    return { size: info.size, modified: info.mtime };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Get a Bun.file() reference for streaming responses.
 */
export function getFileRef(bucket: string, path: string) {
  return Bun.file(join(STORAGE_DIR, bucket, path));
}

/**
 * Get the absolute filesystem path for a file.
 */
export function getFilePath(bucket: string, path: string): string {
  return join(STORAGE_DIR, bucket, path);
}
