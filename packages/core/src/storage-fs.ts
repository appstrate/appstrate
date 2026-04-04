// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

import { mkdir, unlink, realpath } from "node:fs/promises";
import { join, dirname, normalize, resolve as resolvePath } from "node:path";
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
  const base = resolvePath(config.basePath);

  function makeKey(bucket: string, filePath: string): string {
    // Check raw input for traversal before normalization (matches S3 storage behavior)
    const raw = `${bucket}/${filePath}`;
    if (raw.includes("..") || raw.includes("\0")) throw new Error("Path traversal detected");
    return normalize(join(bucket, filePath));
  }

  function resolve(bucket: string, filePath: string): string {
    const fullPath = normalize(join(base, makeKey(bucket, filePath)));
    // Post-resolution containment check — prevent absolute path escapes (e.g. /etc/passwd)
    if (!fullPath.startsWith(base + "/") && fullPath !== base) {
      throw new Error("Path traversal detected");
    }
    return fullPath;
  }

  /**
   * Verify that a resolved path stays within the base directory after symlink resolution.
   * Called after file creation to catch symlink-based escapes.
   */
  async function verifyContainment(fullPath: string): Promise<void> {
    try {
      const real = await realpath(fullPath);
      const realBase = await realpath(base);
      if (!real.startsWith(realBase + "/") && real !== realBase) {
        throw new Error("Path traversal detected via symlink");
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return; // file doesn't exist yet
      throw err;
    }
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
      await verifyContainment(dirname(fullPath));
      await Bun.write(fullPath, data);
      await verifyContainment(fullPath);
      return makeKey(bucket, path);
    },

    async downloadFile(bucket, path) {
      const fullPath = resolve(bucket, path);
      await verifyContainment(fullPath);
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
