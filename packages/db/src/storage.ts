import { join } from "node:path";
import { mkdir, rm, readdir } from "node:fs/promises";
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
