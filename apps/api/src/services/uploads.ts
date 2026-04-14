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

import { and, eq, lt, isNull, inArray, sql } from "drizzle-orm";
import { fileTypeFromBuffer } from "file-type";
import { db } from "@appstrate/db/client";
import { uploads } from "@appstrate/db/schema";
import {
  uploadFile as storagePut,
  downloadFile as storageGet,
  deleteFile as storageDelete,
  createUploadUrl,
} from "@appstrate/db/storage";
import { prefixedId } from "../lib/ids.ts";
import { logger } from "../lib/logger.ts";
import { invalidRequest, notFound, conflict, gone } from "../lib/errors.ts";

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

/** Extract the upload id from an `upload://upl_xxx` URI. */
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
  if (!Number.isFinite(params.size) || params.size <= 0) {
    throw invalidRequest("size must be a positive integer", "size");
  }
  const maxSize = params.maxSize ?? DEFAULT_MAX_SIZE;
  if (params.size > maxSize) {
    throw invalidRequest(`size exceeds ${maxSize} bytes`, "size");
  }
  if (!params.mime) {
    throw invalidRequest("mime is required", "mime");
  }

  const expiresIn = Math.min(Math.max(params.expiresIn ?? DEFAULT_EXPIRY_SECONDS, 60), 3600);
  const uploadId = prefixedId("upl");
  const safeName = sanitizeFilename(params.name);
  const storagePath = `${params.applicationId}/${uploadId}/${safeName}`;

  const descriptor = await createUploadUrl(UPLOAD_BUCKET, storagePath, {
    mime: params.mime,
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
    mime: params.mime,
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
  if (mime === "application/json") return true;
  if (mime === "application/xml" || mime === "application/x-yaml") return true;
  if (mime === "application/javascript" || mime === "application/ecmascript") return true;
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

  // Atomic claim: only the caller whose UPDATE flips NULL → now() proceeds.
  // Any racing caller gets zero rows back and is reported as already-consumed.
  const claimed = await db
    .update(uploads)
    .set({ consumedAt: new Date() })
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

  const [bucket, ...rest] = row.storageKey.split("/");
  const path = rest.join("/");
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

  return {
    id: uploadId,
    name: row.name,
    mime: row.mime,
    size: buffer.length,
    buffer,
  };
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
 */
export async function writeFsUploadContent(
  storageKey: string,
  data: Uint8Array,
): Promise<FsContentWriteResult> {
  const [bucket, ...rest] = storageKey.split("/");
  if (!bucket || rest.length === 0) throw invalidRequest("invalid storage key");
  await storagePut(bucket, rest.join("/"), data);
  return { storageKey, size: data.byteLength };
}

// ---------------------------------------------------------------------------
// GC
// ---------------------------------------------------------------------------

/**
 * Delete uploads whose pre-signed URL has expired and that were never consumed.
 * Also removes the underlying storage object on a best-effort basis.
 * Returns the number of rows removed.
 */
export async function cleanupExpiredUploads(): Promise<number> {
  let totalRemoved = 0;
  // Drain in batches — a long-running instance may accumulate more than the
  // per-query cap between sweeps.
  while (true) {
    const expired = await db
      .select({ id: uploads.id, storageKey: uploads.storageKey })
      .from(uploads)
      .where(and(lt(uploads.expiresAt, new Date()), isNull(uploads.consumedAt)))
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
