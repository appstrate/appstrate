// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

import { mkdir, unlink, realpath } from "node:fs/promises";
import { join, dirname, normalize, resolve as resolvePath } from "node:path";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Storage, CreateUploadUrlOptions, UploadUrlDescriptor } from "./storage.ts";

/** Configuration for the filesystem storage backend. */
export interface FileSystemStorageConfig {
  /** Root directory for all stored files. */
  basePath: string;
  /**
   * Absolute public base URL of the API (used to build upload URLs). Required to
   * generate signed upload URLs pointing at /api/uploads/_content.
   * Example: "http://localhost:3000".
   */
  uploadBaseUrl?: string;
  /**
   * Secret used to HMAC-sign upload tokens. Required when createUploadUrl() is called.
   * Should be a high-entropy server-side secret (e.g. BETTER_AUTH_SECRET).
   */
  uploadSecret?: string;
}

/** Payload encoded inside an upload token. */
export interface FsUploadTokenPayload {
  /** Full storage key (bucket/path) the upload targets. */
  k: string;
  /** Max size in bytes; 0 or missing means "no limit". */
  s: number;
  /** Declared MIME type; empty string means "any". */
  m: string;
  /** Expiration unix timestamp (seconds). */
  e: number;
}

/**
 * Encode + HMAC-sign an upload token.
 * Format: base64url(JSON).base64url(HMAC-SHA256).
 */
export function signFsUploadToken(payload: FsUploadTokenPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

/**
 * Verify + decode an upload token. Returns the payload on success, null on any failure.
 * Constant-time signature comparison; rejects expired tokens.
 */
export function verifyFsUploadToken(token: string, secret: string): FsUploadTokenPayload | null {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload: FsUploadTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf-8")) as FsUploadTokenPayload;
  } catch {
    return null;
  }
  if (typeof payload.e !== "number" || payload.e < Math.floor(Date.now() / 1000)) return null;
  if (typeof payload.k !== "string" || !payload.k) return null;
  return payload;
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

    async fileExists(bucket, path) {
      const fullPath = resolve(bucket, path);
      await verifyContainment(fullPath);
      return Bun.file(fullPath).exists();
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

    async createUploadUrl(
      bucket: string,
      path: string,
      opts?: CreateUploadUrlOptions,
    ): Promise<UploadUrlDescriptor> {
      if (!config.uploadSecret) {
        throw new Error(
          "FileSystemStorage.createUploadUrl() requires config.uploadSecret to sign tokens",
        );
      }
      if (!config.uploadBaseUrl) {
        throw new Error(
          "FileSystemStorage.createUploadUrl() requires config.uploadBaseUrl to build URLs",
        );
      }
      const expiresIn = opts?.expiresIn ?? 900;
      const key = makeKey(bucket, path);
      const token = signFsUploadToken(
        {
          k: key,
          s: opts?.maxSize ?? 0,
          m: opts?.mime ?? "",
          e: Math.floor(Date.now() / 1000) + expiresIn,
        },
        config.uploadSecret,
      );
      const url = `${config.uploadBaseUrl.replace(/\/+$/, "")}/api/uploads/_content?token=${encodeURIComponent(token)}`;
      const headers: Record<string, string> = {};
      if (opts?.mime) headers["Content-Type"] = opts.mime;
      return { url, method: "PUT", headers, expiresIn };
    },
  };
}
