// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

import { mkdir, unlink, realpath, writeFile, open, readdir, stat } from "node:fs/promises";
import { join, dirname, normalize, relative, sep, resolve as resolvePath } from "node:path";
import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  Storage,
  CreateUploadUrlOptions,
  CreateDownloadUrlOptions,
  UploadUrlDescriptor,
} from "./storage.ts";
import { StorageAlreadyExistsError } from "./storage.ts";

/**
 * FileSink buffer watermark for `uploadStream` (bytes). The sink flushes to disk
 * once pending writes cross this threshold, capping resident memory per stream.
 * 1 MiB trades a few extra writes for bounded memory under the 256 MiB doc cap.
 */
const STREAM_FLUSH_BYTES = 1024 * 1024;

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
   * Should be a high-entropy server-side secret (e.g. UPLOAD_SIGNING_SECRET).
   *
   * Accepts a keyring for online rotation — either an array of keys or a
   * comma-separated string: the FIRST key signs new tokens, ALL keys verify.
   * Individual keys must therefore not contain commas.
   */
  uploadSecret?: string | readonly string[];
}

/**
 * Normalize an upload-signing secret into a keyring. A plain string is split
 * on commas (rotation: prepend the new key); empty segments are dropped.
 */
function toUploadKeyring(secret: string | readonly string[]): string[] {
  const keys = typeof secret === "string" ? secret.split(",") : [...secret];
  return keys.filter((k) => k.length > 0);
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
  /**
   * Optional client-declared SHA-256 of the payload (lowercase hex). Signed into
   * the token so the proxy sink can re-hash the streamed bytes and reject a
   * mismatch before the object becomes visible. Absent ⇒ no integrity binding.
   */
  h?: string;
}

/**
 * Encode + HMAC-sign an upload token with the FIRST key of the keyring.
 * Format: base64url(JSON).base64url(HMAC-SHA256).
 */
export function signFsUploadToken(
  payload: FsUploadTokenPayload,
  secret: string | readonly string[],
): string {
  const [activeKey] = toUploadKeyring(secret);
  if (!activeKey) throw new Error("signFsUploadToken requires at least one signing key");
  const body = Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url");
  const sig = createHmac("sha256", activeKey).update(body).digest("base64url");
  return `${body}.${sig}`;
}

/**
 * Verify + decode an upload token. Returns the payload on success, null on any failure.
 * Verifies against EVERY key of the keyring (constant-time comparison per key)
 * so tokens signed before a rotation stay valid; rejects expired tokens.
 */
export function verifyFsUploadToken(
  token: string,
  secret: string | readonly string[],
): FsUploadTokenPayload | null {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const a = Buffer.from(sig);
  let valid = false;
  for (const key of toUploadKeyring(secret)) {
    const b = Buffer.from(createHmac("sha256", key).update(body).digest("base64url"));
    if (a.length === b.length && timingSafeEqual(a, b)) {
      valid = true;
      break;
    }
  }
  if (!valid) return null;
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

/** Config for building app-domain signed proxy-upload URLs. */
export interface ProxyUploadUrlConfig {
  /** Absolute public base URL of the API (e.g. `APP_URL`). */
  uploadBaseUrl: string;
  /** HMAC keyring for upload tokens (e.g. `UPLOAD_SIGNING_SECRET`). */
  uploadSecret: string | readonly string[];
}

/**
 * Build a signed app-domain upload descriptor pointing at the platform's
 * `PUT /api/uploads/_content` sink. Shared by the filesystem backend (its
 * only upload path) and the S3 backend's proxy mode (no public S3 endpoint
 * configured): the client PUTs to the platform on the app domain, and the
 * sink streams the body to whichever storage backend is configured — the
 * blob store itself never needs to be publicly reachable.
 */
export function createProxyUploadDescriptor(
  config: ProxyUploadUrlConfig,
  key: string,
  opts?: CreateUploadUrlOptions,
): UploadUrlDescriptor {
  const expiresIn = opts?.expiresIn ?? 900;
  const token = signFsUploadToken(
    {
      k: key,
      s: opts?.maxSize ?? 0,
      m: opts?.mime ?? "",
      e: Math.floor(Date.now() / 1000) + expiresIn,
      ...(opts?.sha256 && opts.sha256.length > 0 ? { h: opts.sha256 } : {}),
    },
    config.uploadSecret,
  );
  // Trim trailing slashes with a loop rather than /\/+$/ — the regex is
  // polynomial on inputs like "http://x/////" and CodeQL flags it as ReDoS.
  let baseUrl = config.uploadBaseUrl;
  while (baseUrl.endsWith("/")) baseUrl = baseUrl.slice(0, -1);
  const url = `${baseUrl}/api/uploads/_content?token=${encodeURIComponent(token)}`;
  const headers: Record<string, string> = {};
  if (opts?.mime) headers["Content-Type"] = opts.mime;
  return { url, method: "PUT", headers, expiresIn };
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

    async uploadFile(bucket, path, data, opts) {
      const fullPath = resolve(bucket, path);
      await mkdir(dirname(fullPath), { recursive: true });
      await verifyContainment(dirname(fullPath));
      if (opts?.exclusive) {
        // "wx" = O_CREAT | O_EXCL — atomic "create-new-or-fail". Prevents two
        // concurrent PUTs with the same signed token from both succeeding
        // (Bun.write is overwrite-by-default and has no exclusive flag).
        try {
          await writeFile(fullPath, data, { flag: "wx" });
        } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException).code === "EEXIST") {
            throw new StorageAlreadyExistsError();
          }
          throw err;
        }
      } else {
        await Bun.write(fullPath, data);
      }
      await verifyContainment(fullPath);
      return makeKey(bucket, path);
    },

    async uploadStream(bucket, path, stream, opts) {
      const fullPath = resolve(bucket, path);
      await mkdir(dirname(fullPath), { recursive: true });
      await verifyContainment(dirname(fullPath));
      if (opts?.exclusive) {
        // "wx" = O_CREAT | O_EXCL — same atomic create-new-or-fail primitive as
        // uploadFile, but the body is pulled from the stream chunk-by-chunk
        // through the filehandle, never buffered whole. Used by the FS
        // direct-upload sink: replay protection (single-use signed token) plus
        // bounded memory for bodies up to the signed max.
        let fh: Awaited<ReturnType<typeof open>>;
        try {
          fh = await open(fullPath, "wx");
        } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException).code === "EEXIST") {
            throw new StorageAlreadyExistsError();
          }
          throw err;
        }
        const reader = stream.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            await fh.write(value);
          }
          await fh.close();
        } catch (err) {
          await fh.close().catch(() => {});
          await reader.cancel(err).catch(() => {});
          // O_EXCL guarantees THIS call created the file, so a failed write
          // must remove the partial — a leftover would make every retry with
          // the still-valid token 409 until GC sweeps it.
          await unlink(fullPath).catch(() => {});
          throw err;
        }
        await verifyContainment(fullPath);
        return makeKey(bucket, path);
      }
      // Pull the web ReadableStream chunk-by-chunk into a FileSink — never
      // buffering the whole payload in memory.
      //
      // We deliberately do NOT use `Bun.write(path, new Response(stream))`:
      // for a non-trivial (file-backed / async / transform-piped) stream that
      // call hangs indefinitely, and `Bun.write(path, stream)` without the
      // Response wrapper silently stringifies the stream object to disk
      // ("[object ReadableStream]") instead of streaming its bytes. The
      // explicit reader loop drives the source — including any upstream
      // TransformStream (e.g. the consume byte-counter) — and surfaces a
      // mid-stream `controller.error()` as a thrown read so the caller can
      // roll back the partially-written destination.
      //
      // `highWaterMark` is load-bearing: a default FileSink accumulates *every*
      // written chunk in memory and flushes only on `end()`, which would
      // reintroduce the full in-memory buffering this streaming path exists to
      // avoid. With an explicit watermark the sink flushes to disk once the
      // pending buffer crosses it, bounding resident memory to ~one watermark.
      const writer = Bun.file(fullPath).writer({ highWaterMark: STREAM_FLUSH_BYTES });
      const reader = stream.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          writer.write(value);
        }
        await writer.end();
      } catch (err) {
        // Flush + close the sink so the partial file's fd is released (the
        // caller rolls back the destination namespace), and cancel the source
        // so its underlying fd/socket isn't leaked. `end()` returns a byte
        // count (not a promise), so guard rather than chaining `.catch`.
        try {
          await writer.end();
        } catch {
          // already errored — nothing to recover
        }
        await reader.cancel(err).catch(() => {});
        throw err;
      }
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

    async downloadStream(bucket, path) {
      const fullPath = resolve(bucket, path);
      await verifyContainment(fullPath);
      const file = Bun.file(fullPath);
      if (!(await file.exists())) return null;
      // Bun.file().stream() is a lazy, backpressure-aware ReadableStream over
      // the file handle — no full read into memory.
      return file.stream();
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

    async *listObjects(bucket, prefix) {
      // The bucket maps to a directory tree under `${base}/${bucket}`; walk it
      // depth-first and yield each file's in-bucket key (relative to the bucket
      // root, POSIX-separated so it matches the S3 backend and the `path` form
      // deleteFile accepts). A missing bucket directory yields nothing.
      const bucketRoot = resolve(bucket, "");
      async function* walk(dir: string): AsyncGenerator<string> {
        let entries;
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
          throw err;
        }
        for (const entry of entries) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) yield* walk(full);
          else if (entry.isFile()) yield full;
        }
      }
      const wantPrefix = prefix ?? "";
      for await (const full of walk(bucketRoot)) {
        const key = relative(bucketRoot, full).split(sep).join("/");
        if (wantPrefix && !key.startsWith(wantPrefix)) continue;
        let size: number | undefined;
        try {
          size = (await stat(full)).size;
        } catch {
          size = undefined;
        }
        yield { key, size };
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
      return createProxyUploadDescriptor(
        { uploadBaseUrl: config.uploadBaseUrl, uploadSecret: config.uploadSecret },
        makeKey(bucket, path),
        opts,
      );
    },

    // Filesystem storage has no browser-reachable object URL — the caller
    // proxy-streams the bytes through the API instead.
    async createDownloadUrl(
      _bucket: string,
      _path: string,
      _opts?: CreateDownloadUrlOptions,
    ): Promise<string | null> {
      return null;
    },
  };
}
