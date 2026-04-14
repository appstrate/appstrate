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

import { and, eq, lt, isNull, inArray } from "drizzle-orm";
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
import { invalidRequest, notFound } from "../lib/errors.ts";

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
 * Look up an upload row, verify ownership + freshness, download the payload,
 * sniff the MIME via magic bytes, and mark it consumed.
 *
 * Throws `invalidRequest` / `notFound` with stable codes — callers map them
 * back to RFC 9457 problem responses via the error handler.
 */
export async function consumeUpload(
  uploadId: string,
  ctx: { orgId: string; applicationId: string },
): Promise<ConsumedUpload> {
  const [row] = await db.select().from(uploads).where(eq(uploads.id, uploadId)).limit(1);
  if (!row) throw notFound(`Upload '${uploadId}' not found`);
  if (row.orgId !== ctx.orgId || row.applicationId !== ctx.applicationId) {
    // Hide cross-tenant existence
    throw notFound(`Upload '${uploadId}' not found`);
  }
  if (row.consumedAt) {
    throw invalidRequest(`Upload '${uploadId}' has already been consumed`);
  }
  if (row.expiresAt.getTime() < Date.now()) {
    throw invalidRequest(`Upload '${uploadId}' has expired`);
  }

  const [bucket, ...rest] = row.storageKey.split("/");
  const path = rest.join("/");
  const data = await storageGet(bucket!, path);
  if (!data) {
    throw invalidRequest(`Upload '${uploadId}' binary is missing — client did not PUT the file`);
  }

  const buffer = Buffer.from(data);

  // Magic-byte MIME check (file-type reads first ~4100 bytes)
  const sniffed = await fileTypeFromBuffer(buffer);
  if (sniffed && row.mime && sniffed.mime !== row.mime) {
    logger.warn("upload mime mismatch on consume", {
      uploadId,
      declared: row.mime,
      sniffed: sniffed.mime,
    });
    throw invalidRequest(
      `Upload '${uploadId}' content type '${sniffed.mime}' does not match declared '${row.mime}'`,
    );
  }
  if (buffer.length !== row.size) {
    logger.warn("upload size mismatch on consume", {
      uploadId,
      declared: row.size,
      actual: buffer.length,
    });
  }

  await db.update(uploads).set({ consumedAt: new Date() }).where(eq(uploads.id, uploadId));

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
  const now = new Date();
  const expired = await db
    .select({ id: uploads.id, storageKey: uploads.storageKey })
    .from(uploads)
    .where(and(lt(uploads.expiresAt, now), isNull(uploads.consumedAt)))
    .limit(500);

  if (expired.length === 0) return 0;

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

  return expired.length;
}
