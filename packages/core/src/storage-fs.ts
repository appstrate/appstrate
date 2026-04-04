// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

import { mkdir, unlink } from "node:fs/promises";
import { join, dirname, normalize } from "node:path";
import type { Storage } from "./storage.ts";

/** Configuration for the filesystem storage backend. */
export interface FileSystemStorageConfig {
  /** Root directory for all stored files. */
  basePath: string;
}

/**
 * Create a filesystem-backed Storage implementation.
 * Drop-in replacement for S3 storage — stores files on the local disk.
 * Suitable for single-instance self-hosted deployments and development.
 * @param config - Filesystem storage configuration (basePath)
 * @returns A Storage instance backed by the local filesystem
 */
export function createFileSystemStorage(config: FileSystemStorageConfig): Storage {
  const base = config.basePath;

  function makeKey(bucket: string, filePath: string): string {
    // Check raw input for traversal before normalization (matches S3 storage behavior)
    const raw = `${bucket}/${filePath}`;
    if (raw.includes("..")) throw new Error("Path traversal detected");
    return normalize(join(bucket, filePath));
  }

  function resolve(bucket: string, filePath: string): string {
    return join(base, makeKey(bucket, filePath));
  }

  return {
    async ensureBucket() {
      await mkdir(base, { recursive: true });
    },

    safePath(bucket, filePath) {
      return makeKey(bucket, filePath);
    },

    async uploadFile(bucket, path, data) {
      const fullPath = resolve(bucket, path);
      await mkdir(dirname(fullPath), { recursive: true });
      await Bun.write(fullPath, data);
      return makeKey(bucket, path);
    },

    async downloadFile(bucket, path) {
      const fullPath = resolve(bucket, path);
      const file = Bun.file(fullPath);
      if (!(await file.exists())) return null;
      return new Uint8Array(await file.arrayBuffer());
    },

    async deleteFile(bucket, path) {
      const fullPath = resolve(bucket, path);
      try {
        await unlink(fullPath);
      } catch (err: unknown) {
        // Ignore file-not-found, rethrow everything else
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    },
  };
}
