// SPDX-License-Identifier: Apache-2.0

/**
 * Uploads service — direct-upload lifecycle.
 *
 *   POST /api/uploads       → createUpload()  (row + signed URL)
 *   PUT  <signed url>       → (S3 direct, or /api/uploads/_content for FS)
 *   POST /api/agents/:id/run { input: { file: "upload://upl_xxx" } }
 *                            → consumeUpload() resolves to buffer, marks consumed
 *
 * Security layers:
 *  - Auth + app context on POST /api/uploads (middleware)
 *  - Pre-signed URL or HMAC token on PUT
 *  - Magic-byte MIME sniffing on consumption (rejects mismatch)
 *  - Expiry window (default 15 min) + GC worker removes orphans
 */

import { and, eq, lt, isNull, isNotNull, inArray, or, sql } from "drizzle-orm";
import { fileTypeFromBuffer } from "file-type";
import { db } from "@appstrate/db/client";
import { uploads } from "@appstrate/db/schema";
import {
  uploadFile as storagePut,
  downloadFile as storageGet,
  deleteFile as storageDelete,
  createUploadUrl,
} from "@appstrate/db/storage";
import { StorageAlreadyExistsError } from "@appstrate/core/storage";
import { prefixedId } from "../lib/ids.ts";
import { logger } from "../lib/logger.ts";
import { invalidRequest, notFound, conflict, gone } from "../lib/errors.ts";

/** Strip charset / boundary / other parameters from a MIME string and lowercase it. */
function normalizeMime(mime: string): string {
  return mime.split(";")[0]?.trim().toLowerCase() ?? "";
}

const UPLOAD_BUCKET = "uploads";
const DEFAULT_EXPIRY_SECONDS = 900; // 15 min
const MAX_FILENAME_LEN = 255;
const DEFAULT_MAX_SIZE = 100 * 1024 * 1024; // 100 MB absolute ceiling

/** `upload://upl_xxx` — the URI form stored inside agent input JSON. */
export const UPLOAD_URI_PREFIX = "upload://";

/** Returned to the client from POST /api/uploads. */
export interface CreateUploadResponse {
  object: "upload";
  id: string;
  uri: string;
  url: string;
  method: "PUT";
  headers: Record<string, string>;
  expiresAt: string;
}

/** Shape consumed by the run pipeline — mirrors UploadedFile from adapters/types. */
export interface ConsumedUpload {
  id: string;
  name: string;
  mime: string;
  size: number;
  buffer: Buffer;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Strip path separators + nulls from a user-supplied filename. */
export function sanitizeFilename(name: string): string {
  const cleaned = name
    .replace(/[/\\\0]/g, "_")
    .replace(/\.\.+/g, ".")
    .trim();
  if (!cleaned) return "file";
  return cleaned.slice(0, MAX_FILENAME_LEN);
}

/** Is this value a reference to a staged upload? */
export function isUploadUri(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(UPLOAD_URI_PREFIX);
}

/**
 * Extract the upload id from an `upload://upl_xxx` URI.
 * The `upl_` prefix matches `prefixedId("upl")` used in `createUpload()`.
 */
export function parseUploadUri(uri: string): string | null {
  if (!uri.startsWith(UPLOAD_URI_PREFIX)) return null;
  const id = uri.slice(UPLOAD_URI_PREFIX.length);
  if (!id.startsWith("upl_")) return null;
  return id;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreateUploadParams {
  orgId: string;
  applicationId: string;
  createdBy: string | null;
  name: string;
  size: number;
  mime: string;
  /** Optional tighter expiry; clamped to [60, 3600]. */
  expiresIn?: number;
  /** Optional max-size ceiling applied to the pre-signed URL. */
  maxSize?: number;
}

export async function createUpload(params: CreateUploadParams): Promise<CreateUploadResponse> {
  if (!params.name || params.name.length > MAX_FILENAME_LEN) {
    throw invalidRequest(`name must be 1-${MAX_FILENAME_LEN} chars`, "name");
  }
  // Zod at the route layer already enforces positive integer; this is a defence-in-depth
  // check for direct service-layer callers.
  if (params.size <= 0) {
    throw invalidRequest("size must be a positive integer", "size");
  }
  const maxSize = params.maxSize ?? DEFAULT_MAX_SIZE;
  if (params.size > maxSize) {
    throw invalidRequest(`size exceeds ${maxSize} bytes`, "size");
  }
  if (!params.mime) {
    throw invalidRequest("mime is required", "mime");
  }

  // Strip parameters (charset, boundary, …) and lowercase so consume-time
  // comparison against sniffed MIME is an exact string match. An attacker
  // padding the declared MIME with junk params would otherwise bypass the
  // magic-byte check.
  const normalizedMime = normalizeMime(params.mime);
  if (!normalizedMime) {
    throw invalidRequest("mime is required", "mime");
  }

  const expiresIn = Math.min(Math.max(params.expiresIn ?? DEFAULT_EXPIRY_SECONDS, 60), 3600);
  const uploadId = prefixedId("upl");
  const safeName = sanitizeFilename(params.name);
  const storagePath = `${params.applicationId}/${uploadId}/${safeName}`;

  const descriptor = await createUploadUrl(UPLOAD_BUCKET, storagePath, {
    mime: normalizedMime,
    maxSize: Math.min(params.size, maxSize),
    expiresIn,
  });

  const expiresAt = new Date(Date.now() + expiresIn * 1000);
  await db.insert(uploads).values({
    id: uploadId,
    orgId: params.orgId,
    applicationId: params.applicationId,
    createdBy: params.createdBy,
    storageKey: `${UPLOAD_BUCKET}/${storagePath}`,
    name: safeName,
    mime: normalizedMime,
    size: params.size,
    expiresAt,
  });

  return {
    object: "upload",
    id: uploadId,
    uri: `${UPLOAD_URI_PREFIX}${uploadId}`,
    url: descriptor.url,
    method: descriptor.method,
    headers: descriptor.headers,
    expiresAt: expiresAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Consume (resolve upload:// → buffer for the run pipeline)
// ---------------------------------------------------------------------------

/**
 * MIME prefixes/values where `file-type` cannot sniff a signature — these
 * formats have no magic bytes (plain text, JSON, CSV, XML source, JS, etc.).
 * For these we skip the sniff check and trust the declared mime. Callers
 * that need strict binary validation should declare a concrete binary MIME
 * (application/pdf, image/*, etc.) which `file-type` can identify.
 */
function isUnsniffableMime(mime: string): boolean {
  if (mime.startsWith("text/")) return true;
  if (mime === "application/json" || mime === "application/x-ndjson") return true;
  if (mime === "application/xml" || mime === "application/x-yaml") return true;
  if (mime === "application/javascript" || mime === "application/ecmascript") return true;
  if (mime === "application/x-www-form-urlencoded") return true;
  return false;
}

/**
 * Look up an upload row, verify ownership + freshness, claim it atomically,
 * download the payload, and sniff the MIME via magic bytes.
 *
 * The claim (`UPDATE … WHERE consumedAt IS NULL RETURNING`) is what prevents
 * the TOCTOU double-consume — two concurrent runs posting the same URI will
 * see exactly one winning row.
 *
 * Throws `invalidRequest` / `notFound` / `conflict` / `gone` with stable
 * codes — callers map them back to RFC 9457 problem responses.
 */
export async function consumeUpload(
  uploadId: string,
  ctx: { orgId: string; applicationId: string },
): Promise<ConsumedUpload> {
  // Pre-check so we can return the right shape of error (not-found vs
  // cross-tenant vs already-consumed vs expired). The atomic claim below
  // is what makes concurrent calls safe — this SELECT is just UX.
  const [row] = await db.select().from(uploads).where(eq(uploads.id, uploadId)).limit(1);
  if (!row) throw notFound(`Upload '${uploadId}' not found`);
  if (row.orgId !== ctx.orgId || row.applicationId !== ctx.applicationId) {
    // Hide cross-tenant existence
    throw notFound(`Upload '${uploadId}' not found`);
  }
  if (row.expiresAt.getTime() < Date.now()) {
    throw gone("upload_expired", `Upload '${uploadId}' has expired`);
  }

  // Atomic claim: only the caller whose UPDATE flips NULL → claimedAt proceeds.
  // Any racing caller gets zero rows back and is reported as already-consumed.
  const claimedAt = new Date();
  const claimed = await db
    .update(uploads)
    .set({ consumedAt: claimedAt })
    .where(
      and(
        eq(uploads.id, uploadId),
        eq(uploads.orgId, ctx.orgId),
        eq(uploads.applicationId, ctx.applicationId),
        isNull(uploads.consumedAt),
        sql`${uploads.expiresAt} >= now()`,
      ),
    )
    .returning({ id: uploads.id });
  if (claimed.length === 0) {
    throw conflict("upload_consumed", `Upload '${uploadId}' has already been consumed`);
  }

  // Past this point the claim has succeeded. If anything downstream throws
  // (storage fetch, size/mime mismatch, …) we must release the claim AND
  // drop the stored object so a retry can re-PUT clean bytes. Without the
  // storage delete, the FS sink would 409 on re-upload (exclusive write),
  // leaving the caller stuck until GC.
  const [bucket, ...rest] = row.storageKey.split("/");
  const path = rest.join("/");
  try {
    const data = await storageGet(bucket!, path);
    if (!data) {
      throw invalidRequest(`Upload '${uploadId}' binary is missing — client did not PUT the file`);
    }

    const buffer = Buffer.from(data);

    // Reject mismatched size outright — an attacker can declare 1KB in the
    // pre-signed request and PUT 100MB if the storage adapter doesn't enforce
    // ContentLength at sign time (S3 currently does not).
    if (buffer.length !== row.size) {
      logger.warn("upload size mismatch on consume", {
        uploadId,
        declared: row.size,
        actual: buffer.length,
      });
      throw invalidRequest(
        `Upload '${uploadId}' size mismatch: declared ${row.size} bytes, got ${buffer.length}`,
      );
    }

    // Magic-byte MIME check (file-type reads first ~4100 bytes).
    //
    // When the manifest declares a concrete binary MIME (application/pdf,
    // image/png, …), we require `file-type` to recognise the bytes AND match.
    // This closes the "client declares PDF, uploads plain text" hole.
    //
    // Two escape hatches:
    //  - `application/octet-stream` is the explicit "any blob" marker.
    //  - Text-ish MIMEs (text/*, application/json, application/xml, …) have
    //    no magic signature, so `file-type` always returns undefined for them.
    //    Strict matching would reject every legitimate text upload. We trust
    //    the declared MIME for these — manifests that need binary-grade
    //    validation must declare a sniffable MIME.
    if (row.mime && row.mime !== "application/octet-stream" && !isUnsniffableMime(row.mime)) {
      const sniffed = await fileTypeFromBuffer(buffer);
      if (!sniffed || sniffed.mime !== row.mime) {
        logger.warn("upload mime mismatch on consume", {
          uploadId,
          declared: row.mime,
          sniffed: sniffed?.mime ?? null,
        });
        throw invalidRequest(
          sniffed
            ? `Upload '${uploadId}' content type '${sniffed.mime}' does not match declared '${row.mime}'`
            : `Upload '${uploadId}' content does not match declared mime '${row.mime}'`,
        );
      }
    }

    // The buffer is now in memory and will be injected into the run container.
    // The storage copy is dead weight from here on — delete it best-effort so
    // we don't leak S3/FS objects for every run. The GC's consumed-retention
    // sweep is the safety net when this delete fails.
    await storageDelete(bucket!, path).catch((delErr) => {
      logger.warn("failed to delete upload storage after consume", {
        uploadId,
        error: delErr instanceof Error ? delErr.message : String(delErr),
      });
    });

    return {
      id: uploadId,
      name: row.name,
      mime: row.mime,
      size: buffer.length,
      buffer,
    };
  } catch (err) {
    // Release the claim so the row can be re-consumed after the client re-uploads.
    // Guarded by `consumedAt = claimedAt` so we only ever release OUR claim —
    // a hypothetical concurrent consume that somehow held the row would be
    // left untouched.
    await db
      .update(uploads)
      .set({ consumedAt: null })
      .where(and(eq(uploads.id, uploadId), eq(uploads.consumedAt, claimedAt)))
      .catch((releaseErr) => {
        logger.warn("failed to release upload claim after consume error", {
          uploadId,
          error: releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
        });
      });
    // Best-effort: drop the stored bytes so the next createUpload + PUT can
    // succeed against a fresh exclusive-write slot. We intentionally do not
    // delete on missing-binary errors (nothing to delete) but the storage
    // adapter's deleteFile is idempotent on ENOENT, so the unconditional
    // call is safe.
    await storageDelete(bucket!, path).catch((delErr) => {
      logger.warn("failed to delete upload storage after consume error", {
        uploadId,
        error: delErr instanceof Error ? delErr.message : String(delErr),
      });
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Filesystem content sink (PUT /api/uploads/_content?token=...)
// ---------------------------------------------------------------------------

export interface FsContentWriteResult {
  storageKey: string;
  size: number;
}

/**
 * Write the body of a PUT to storage (FS adapter path). Token verification +
 * header checks happen in the route handler — this just streams to disk.
 *
 * Atomic create-or-fail: refuses to overwrite an existing object at the same
 * storage key via O_EXCL. The signed token is valid for 15 min and could
 * otherwise be replayed within its window to swap the bytes of an already-
 * populated upload between client PUT and server-side consume.
 */
export async function writeFsUploadContent(
  storageKey: string,
  data: Uint8Array,
): Promise<FsContentWriteResult> {
  const [bucket, ...rest] = storageKey.split("/");
  if (!bucket || rest.length === 0) throw invalidRequest("invalid storage key");
  const path = rest.join("/");
  try {
    await storagePut(bucket, path, data, { exclusive: true });
  } catch (err) {
    if (err instanceof StorageAlreadyExistsError) {
      throw conflict("upload_already_written", "upload content has already been written");
    }
    throw err;
  }
  return { storageKey, size: data.byteLength };
}

// ---------------------------------------------------------------------------
// GC
// ---------------------------------------------------------------------------

/**
 * Retention window for consumed uploads before the GC drops the row (and any
 * orphaned storage object). The successful-consume path deletes the object
 * inline, so the sweep usually finds the storage key already gone — this is
 * the safety net for cases where the inline delete failed transiently.
 */
const CONSUMED_RETENTION_MS = 24 * 60 * 60 * 1000; // 24 h

/**
 * Delete uploads that are no longer needed:
 *   - expired AND never consumed (user never finished the PUT, or declared
 *     MIME was wrong and they abandoned the flow), OR
 *   - consumed more than `CONSUMED_RETENTION_MS` ago (the run already ran;
 *     storage object should have been removed inline on consume, but this is
 *     the safety net if that best-effort delete failed).
 *
 * Storage objects are removed on a best-effort basis. Returns the number of
 * rows removed.
 */
export async function cleanupExpiredUploads(): Promise<number> {
  let totalRemoved = 0;
  // Drain in batches — a long-running instance may accumulate more than the
  // per-query cap between sweeps.
  while (true) {
    const now = new Date();
    const consumedCutoff = new Date(now.getTime() - CONSUMED_RETENTION_MS);
    const expired = await db
      .select({ id: uploads.id, storageKey: uploads.storageKey })
      .from(uploads)
      .where(
        or(
          and(lt(uploads.expiresAt, now), isNull(uploads.consumedAt)),
          and(isNotNull(uploads.consumedAt), lt(uploads.consumedAt, consumedCutoff)),
        ),
      )
      .limit(500);

    if (expired.length === 0) break;

    await Promise.all(
      expired.map(async (row) => {
        const [bucket, ...rest] = row.storageKey.split("/");
        if (!bucket || rest.length === 0) return;
        try {
          await storageDelete(bucket, rest.join("/"));
        } catch (err) {
          logger.warn("failed to delete expired upload storage", {
            uploadId: row.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    );

    const ids = expired.map((r) => r.id);
    await db.delete(uploads).where(inArray(uploads.id, ids));
    totalRemoved += expired.length;
    if (expired.length < 500) break;
  }
  return totalRemoved;
}

// ---------------------------------------------------------------------------
// Periodic GC timer
// ---------------------------------------------------------------------------

/** How often the background sweep runs. Aligned with the 15-min expiry window. */
const UPLOAD_GC_INTERVAL_MS = 15 * 60 * 1000;

let gcTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start a background sweep that drains expired unconsumed uploads on a fixed
 * interval. Safe to call multiple times — a no-op after the first.
 */
export function startUploadGc(): void {
  if (gcTimer) return;
  gcTimer = setInterval(() => {
    cleanupExpiredUploads()
      .then((count) => {
        if (count > 0) logger.info("Removed expired unconsumed uploads", { count });
      })
      .catch((err) => {
        logger.warn("Periodic upload GC failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }, UPLOAD_GC_INTERVAL_MS);
  // Don't hold the event loop open for this timer alone.
  gcTimer.unref?.();
}

/** Stop the background sweep. Called from the shutdown handler. */
export function stopUploadGc(): void {
  if (gcTimer) {
    clearInterval(gcTimer);
    gcTimer = null;
  }
}
