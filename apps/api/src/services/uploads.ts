// SPDX-License-Identifier: Apache-2.0

/**
 * Uploads service — direct-upload lifecycle.
 *
 *   POST /api/uploads       → createUpload()  (row + signed URL)
 *   PUT  <signed url>       → /api/uploads/_content proxy sink (FS storage,
 *                             and S3 in proxy mode), or direct-to-bucket
 *                             presigned PUT (S3 with S3_PUBLIC_ENDPOINT set)
 *   POST /api/agents/:id/run { input: { file: "upload://upl_xxx" } }
 *                            → consumeUploadStream() streams the bytes to the
 *                              caller's sink + stamps consumedAt (no buffering)
 *
 * Consumed uploads are NOT single-use: the bytes stay retained — and the same
 * `upload://` URI stays re-consumable — for `UPLOAD_RETENTION_HOURS` (default
 * 24 h) after the FIRST consume. This is what lets a run be re-triggered with
 * the same input (cancel → change model → `rerun_from`) without a
 * byte-identical re-upload. The GC sweep drops the row + storage object once
 * the window elapses.
 *
 * Security layers:
 *  - Auth + app context on POST /api/uploads (middleware)
 *  - Pre-signed URL or HMAC token on PUT
 *  - Magic-byte MIME sniffing on consumption (rejects mismatch, every consume)
 *  - Expiry window (default 15 min) for the PUT, post-consume reuse window
 *    for re-consume + GC worker removes both kinds of leftovers
 */

import { and, eq, lt, isNull, isNotNull, inArray, or, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { uploads } from "@appstrate/db/schema";
import {
  uploadStream as storageUploadStream,
  downloadStream as storageDownloadStream,
  deleteFile as storageDelete,
  createUploadUrl,
} from "@appstrate/db/storage";
import { getErrorMessage } from "@appstrate/core/errors";
import { StorageAlreadyExistsError } from "@appstrate/core/storage";
import { UPLOAD_URI_PREFIX, UPLOAD_ID_RE } from "@appstrate/core/document-uri";
import { getEnv } from "@appstrate/env";
import { prefixedId } from "../lib/ids.ts";
import { logger } from "../lib/logger.ts";
import { invalidRequest, notFound, conflict, gone, unauthorized } from "../lib/errors.ts";

/** Strip charset / boundary / other parameters from a MIME string and lowercase it. */
export function normalizeMime(mime: string): string {
  return mime.split(";")[0]?.trim().toLowerCase() ?? "";
}

const UPLOAD_BUCKET = "uploads";
const DEFAULT_EXPIRY_SECONDS = 900; // 15 min
const MAX_FILENAME_LEN = 255;
const DEFAULT_MAX_SIZE = 100 * 1024 * 1024; // 100 MB absolute ceiling

/**
 * Post-consume reuse window in milliseconds. Within `consumedAt + this`, a
 * consumed upload's bytes are still retained and the URI re-consumable; past
 * it the GC sweep drops the row + object. Read lazily so tests / operators
 * can tune `UPLOAD_RETENTION_HOURS` without re-importing the module.
 */
function consumedRetentionMs(): number {
  return getEnv().UPLOAD_RETENTION_HOURS * 60 * 60 * 1000;
}

/** Is a consumed upload still within its post-consume reuse window? */
function isWithinReuseWindow(consumedAt: Date): boolean {
  return consumedAt.getTime() + consumedRetentionMs() > Date.now();
}

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

/**
 * Declared metadata for a staged upload: shared by `peekUploads` (read without
 * claiming) and `consumeUploadStream` (returned after the bytes have streamed to
 * the caller's sink). No buffer is carried — mirrors the `FileReference` shape
 * in run-launcher/types.
 */
export interface UploadMeta {
  id: string;
  name: string;
  mime: string;
  size: number;
}

/**
 * Sink the upload bytes are streamed through. Receives the upload's content as
 * a stream and reports how many bytes it observed plus the magic-byte sniffed
 * MIME (undefined for formats `file-type` cannot identify). The caller (consume)
 * validates these against the declared upload row.
 */
export type UploadStreamSink = (
  stream: ReadableStream<Uint8Array>,
) => Promise<{ bytes: number; sniffedMime: string | undefined }>;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Strip path separators + control characters from a user-supplied filename.
 *
 * Defense in depth only — the actual path-traversal block lives in the
 * storage layer (`makeKey()` rejects any raw bucket/path containing `..`
 * or `\0` before touching the filesystem). This helper keeps the stored
 * filename human-readable and prevents a `..` segment from surviving into
 * the final on-disk path even if the storage check ever regressed.
 *
 * Control chars (`\x00-\x1f`, `\x7f`) are collapsed too — CR/LF in a name would
 * otherwise survive into a stored filename and, on the download path, into a
 * `Content-Disposition` header (a response-splitting / header-injection vector
 * the presign path's quote-stripping alone does not cover).
 */
export function sanitizeFilename(name: string): string {
  const cleaned = name
    // eslint-disable-next-line no-control-regex
    .replace(/[/\\\x00-\x1f\x7f]/g, "_")
    .replace(/\.\.+/g, ".")
    .trim();
  if (!cleaned) return "file";
  return cleaned.slice(0, MAX_FILENAME_LEN);
}

/**
 * Extract the upload id from an `upload://upl_xxx` URI. Returns null if the
 * URI is missing the scheme or the id does not match the strict id shape.
 */
export function parseUploadUri(uri: string): string | null {
  if (!uri.startsWith(UPLOAD_URI_PREFIX)) return null;
  const id = uri.slice(UPLOAD_URI_PREFIX.length);
  if (!UPLOAD_ID_RE.test(id)) return null;
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

  // `maxSize` carries the DECLARED size (`params.size <= maxSize` is enforced
  // above, so the min is exactly `params.size`): direct-presign S3 signs it
  // as the presigned PUT's exact Content-Length; the proxy sink (FS storage,
  // or S3 in proxy mode) enforces it as the streaming upper bound. Either
  // way the client cannot upload more than it declared.
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
 *
 * Exported so the inline `data:` URI input path (input-parser) applies the
 * exact same declared-vs-sniffed MIME policy as the staged-upload path.
 */
export function isUnsniffableMime(mime: string): boolean {
  if (mime.startsWith("text/")) return true;
  // Structured text payloads with no reliable magic signature.
  const unsniffable = new Set([
    "application/json",
    "application/x-ndjson",
    "application/ld+json",
    "application/xml",
    "application/x-yaml",
    "application/yaml",
    "application/csv",
    "application/javascript",
    "application/ecmascript",
    "application/x-sh",
    "application/x-httpd-php",
    "application/x-www-form-urlencoded",
    "image/svg+xml", // XML-based, file-type never matches it
  ]);
  if (unsniffable.has(mime)) return true;
  // Structured-suffix convention (RFC 6839) — `+json`, `+xml`, `+yaml`.
  // Anything in these families is text-shaped and cannot be magic-sniffed.
  if (mime.endsWith("+json") || mime.endsWith("+xml") || mime.endsWith("+yaml")) return true;
  return false;
}

/**
 * MIMEs whose on-disk format is a ZIP container. `file-type` samples only the
 * head of the stream (~4100 bytes); when the identifying entry of an OOXML/ODF
 * archive ([Content_Types].xml, mimetype) sits beyond the sample window — the
 * normal layout for openpyxl/LibreOffice/Google-exported files — it falls back
 * to plain `application/zip`. Treating that fallback as a mismatch would
 * reject legitimate office documents, so declared-vs-sniffed comparison uses
 * Marcel/Tika-style subtype refinement: a declared member of this family is
 * compatible with a sniffed `application/zip` (and vice versa). A declaration
 * outside the family (application/pdf, image/png, …) still requires an exact
 * sniff match.
 */
const ZIP_CONTAINER_MIMES = new Set([
  // OOXML
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // xlsx
  "application/vnd.openxmlformats-officedocument.spreadsheetml.template", // xltx
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // docx
  "application/vnd.openxmlformats-officedocument.wordprocessingml.template", // dotx
  "application/vnd.openxmlformats-officedocument.presentationml.presentation", // pptx
  "application/vnd.openxmlformats-officedocument.presentationml.slideshow", // ppsx
  "application/vnd.openxmlformats-officedocument.presentationml.template", // potx
  // OOXML macro-enabled
  "application/vnd.ms-excel.sheet.macroenabled.12", // xlsm
  "application/vnd.ms-excel.template.macroenabled.12", // xltm
  "application/vnd.ms-word.document.macroenabled.12", // docm
  "application/vnd.ms-word.template.macroenabled.12", // dotm
  "application/vnd.ms-powerpoint.presentation.macroenabled.12", // pptm
  "application/vnd.ms-powerpoint.slideshow.macroenabled.12", // ppsm
  // OpenDocument
  "application/vnd.oasis.opendocument.text", // odt
  "application/vnd.oasis.opendocument.spreadsheet", // ods
  "application/vnd.oasis.opendocument.presentation", // odp
  "application/vnd.oasis.opendocument.graphics", // odg
  // Other ZIP-based formats
  "application/epub+zip",
  "application/java-archive", // jar
]);

/**
 * Legacy Office formats stored in an OLE2 / Compound File Binary container.
 * `file-type` identifies the container magic (`application/x-cfb`) but never
 * refines it to the concrete format, so every legitimate legacy Office upload
 * sniffs as the generic parent — same shape as the ZIP family above.
 */
const CFB_CONTAINER_MIMES = new Set([
  "application/msword", // .doc
  "application/vnd.ms-excel", // .xls
  "application/vnd.ms-powerpoint", // .ppt
  "application/vnd.ms-outlook", // .msg
  "application/vnd.visio", // .vsd
]);

/**
 * Container families for declared-vs-sniffed refinement: `generic` is the
 * parent MIME the sniffer reports for the raw container, `members` are the
 * concrete formats stored in it.
 */
const CONTAINER_FAMILIES: ReadonlyArray<{ generic: string; members: Set<string> }> = [
  { generic: "application/zip", members: ZIP_CONTAINER_MIMES },
  { generic: "application/x-cfb", members: CFB_CONTAINER_MIMES },
];

/**
 * Declared-vs-sniffed MIME compatibility for the magic-byte check. Exact match
 * always passes; otherwise refinement is strictly parent↔child against a
 * container family's generic type (declared xlsx / sniffed application/zip,
 * declared application/zip / sniffed xlsx). Two SPECIFIC container types never
 * satisfy each other — declared xlsx with sniffed docm/xlsm stays a mismatch,
 * so a macro-enabled document cannot ride in under a macro-free declaration
 * when the sniffer DID identify it. Exported so the inline `data:` URI input
 * path (input-parser) applies the exact same policy as the staged-upload path.
 */
export function sniffedMimeMatchesDeclared(declared: string, sniffed: string | undefined): boolean {
  if (!sniffed) return false;
  if (sniffed === declared) return true;
  for (const { generic, members } of CONTAINER_FAMILIES) {
    if (sniffed === generic && members.has(declared)) return true;
    if (declared === generic && members.has(sniffed)) return true;
  }
  return false;
}

/**
 * Read declared metadata for a set of staged uploads — without claiming or
 * downloading them. Verifies each exists, belongs to the caller's tenant, and
 * has not expired (same error shapes as consume). Used to enforce the per-run
 * document cap on *declared* sizes before any bytes are streamed: the per-file
 * `bytes === size` check in consume keeps each actual size ≤ its declared size,
 * so a declared total under the cap bounds the actual total too.
 */
export async function peekUploads(
  uploadIds: string[],
  ctx: { orgId: string; applicationId: string },
): Promise<Map<string, UploadMeta>> {
  if (uploadIds.length === 0) return new Map();
  const rows = await db.select().from(uploads).where(inArray(uploads.id, uploadIds));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const result = new Map<string, UploadMeta>();
  for (const id of uploadIds) {
    const row = byId.get(id);
    // Hide cross-tenant existence behind the same not-found as a missing row.
    if (!row || row.orgId !== ctx.orgId || row.applicationId !== ctx.applicationId) {
      throw notFound(`Upload '${id}' not found`);
    }
    // Two validity regimes: an unconsumed upload lives until its PUT-window
    // expiry; a consumed one stays addressable for the post-consume reuse
    // window (its `expiresAt` has usually passed by re-trigger time).
    if (row.consumedAt) {
      if (!isWithinReuseWindow(row.consumedAt)) {
        throw gone("upload_expired", `Upload '${id}' reuse window has elapsed`);
      }
    } else if (row.expiresAt.getTime() < Date.now()) {
      throw gone("upload_expired", `Upload '${id}' has expired`);
    }
    result.set(id, { id, name: row.name, mime: row.mime, size: row.size });
  }
  return result;
}

/**
 * Stream an upload's payload through `sink` (which pipes it to its destination)
 * while validating size + magic-byte MIME on the fly — the platform never
 * buffers the whole upload in memory.
 *
 * Uploads are multi-use within a retention window. The FIRST consume claims the
 * row atomically (`UPDATE … WHERE consumedAt IS NULL … RETURNING` — stamps
 * `consumedAt` and returns the row data in one statement, no pre-check SELECT).
 * Subsequent consumes within `UPLOAD_RETENTION_HOURS` of that first claim
 * re-read the retained object — this is what lets a re-triggered run (cancel →
 * change model → re-run, or `rerun_from`) reuse the same input without a
 * byte-identical re-upload. Concurrent consumes are safe: every consumer
 * streams the same immutable object (the FS sink writes with O_EXCL, so the
 * bytes cannot be swapped after the first PUT) and validates independently.
 *
 * Size + MIME are validated *after* the stream drains (size is only known at
 * end; MIME is sniffed from the head by the sink). On a first-consume mismatch
 * the claim is released and the source object dropped so the client can re-PUT;
 * a failed RE-consume leaves the row + object untouched (other consumers may
 * be streaming it). The sink's partially-written destination is NOT cleaned
 * here — the caller owns the destination namespace (e.g. the run workspace)
 * and rolls it back en bloc.
 *
 * Throws `invalidRequest` / `notFound` / `gone` with stable codes — callers
 * map them back to RFC 9457 problem responses.
 */
export async function consumeUploadStream(
  uploadId: string,
  ctx: { orgId: string; applicationId: string },
  sink: UploadStreamSink,
): Promise<UploadMeta> {
  // Atomic first-consume claim that also reads the row: the caller whose
  // UPDATE flips NULL → claimedAt owns the destructive failure path below,
  // and the same statement hands back the row data (storageKey, size, mime,
  // name) — no separate pre-check SELECT on the happy path. The WHERE guards
  // (tenant + not-consumed + not-expired) make a returned row owned, fresh,
  // and freshly-claimed by construction.
  const claimedAt = new Date();
  const [claimed] = await db
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
    .returning();
  const firstConsume = claimed !== undefined;
  let row = claimed;
  // Nothing claimed → either the upload was already consumed (re-consumable
  // within the reuse window) or it is missing / cross-tenant / expired. The
  // cold path diagnoses which, so the caller still gets a precise error.
  if (!row) {
    const [existing] = await db.select().from(uploads).where(eq(uploads.id, uploadId)).limit(1);
    // Hide cross-tenant existence behind the same not-found as a missing row.
    if (!existing || existing.orgId !== ctx.orgId || existing.applicationId !== ctx.applicationId) {
      throw notFound(`Upload '${uploadId}' not found`);
    }
    if (!existing.consumedAt) {
      // Never consumed and the claim's expiry guard rejected it → PUT window
      // closed before any run used it.
      throw gone("upload_expired", `Upload '${uploadId}' has expired`);
    }
    if (!isWithinReuseWindow(existing.consumedAt)) {
      throw gone("upload_expired", `Upload '${uploadId}' reuse window has elapsed`);
    }
    row = existing;
  }

  // Past this point the consume may proceed. On a FIRST consume, if anything
  // downstream throws (storage fetch, size/mime mismatch, …) we must release
  // the claim AND drop the stored object so a retry can re-PUT clean bytes —
  // without the storage delete, the FS sink would 409 on re-upload (exclusive
  // write), leaving the caller stuck until GC. A failed RE-consume is
  // non-destructive: the object already passed validation once and other
  // consumers may rely on it.
  const [bucket, ...rest] = row.storageKey.split("/");
  const path = rest.join("/");
  try {
    const source = await storageDownloadStream(bucket!, path);
    if (!source) {
      throw invalidRequest(`Upload '${uploadId}' binary is missing — client did not PUT the file`);
    }

    // Stream the bytes through the caller's sink (which pipes them to their
    // destination). The sink reports the observed byte count and the MIME
    // sniffed from the head — both are only known once the stream drains.
    const { bytes, sniffedMime } = await sink(source);

    // Reject mismatched size outright. Both upload paths enforce the declared
    // size at upload time (direct-presign S3 signs ContentLength into the
    // presigned PUT; the proxy sink aborts mid-stream past the signed max) —
    // this re-check is defence in depth, and the only place a SHORTER-than-
    // declared proxy upload is caught (the sink enforces an upper bound, not
    // an exact count).
    if (bytes !== row.size) {
      logger.warn("upload size mismatch on consume", {
        uploadId,
        declared: row.size,
        actual: bytes,
      });
      throw invalidRequest(
        `Upload '${uploadId}' size mismatch: declared ${row.size} bytes, got ${bytes}`,
      );
    }

    // Magic-byte MIME check (the sink sniffs the first ~4100 bytes of the head).
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
      if (!sniffedMimeMatchesDeclared(row.mime, sniffedMime)) {
        logger.warn("upload mime mismatch on consume", {
          uploadId,
          declared: row.mime,
          sniffed: sniffedMime ?? null,
        });
        throw invalidRequest(
          sniffedMime
            ? `Upload '${uploadId}' content type '${sniffedMime}' does not match declared '${row.mime}'`
            : `Upload '${uploadId}' content does not match declared mime '${row.mime}'`,
        );
      }
    }

    // Bytes have been streamed to the sink's destination. The source object is
    // deliberately RETAINED — it stays re-consumable until the post-consume
    // reuse window elapses, at which point the GC sweep drops the row + object.
    return {
      id: uploadId,
      name: row.name,
      mime: row.mime,
      size: bytes,
    };
  } catch (err) {
    // A failed RE-consume must not destroy state that other consumers (and
    // future re-runs) rely on — the object already passed validation on its
    // first consume; this failure is local (transient storage error, or a
    // first consumer racing its own failure rollback). Propagate only.
    if (!firstConsume) throw err;

    // First-consume failure: roll back so the client can re-PUT clean bytes.
    //
    // Order matters: delete the stored bytes FIRST, then release the claim.
    // If we released first, a concurrent consumer could re-claim the row in
    // the window before `storageDelete` completed and race our delete —
    // they'd end up with either truncated bytes or a missing-binary error.
    // Deleting first guarantees the next consumer sees a clean "no binary"
    // state and can instruct the caller to re-PUT.
    //
    // The storage adapter's `deleteFile` is idempotent on ENOENT, so calling
    // it even when there's nothing to delete (missing-binary error path)
    // is safe.
    await storageDelete(bucket!, path).catch((delErr) => {
      logger.warn("failed to delete upload storage after consume error", {
        uploadId,
        error: getErrorMessage(delErr),
      });
    });
    // Release the claim so the row can be re-consumed after the client re-uploads.
    // Guarded by `consumedAt = claimedAt` so we only ever release OUR claim —
    // a concurrent re-consumer never holds the row (re-consume does not
    // mutate it), so this only ever unwinds the claim THIS call took.
    await db
      .update(uploads)
      .set({ consumedAt: null })
      .where(and(eq(uploads.id, uploadId), eq(uploads.consumedAt, claimedAt)))
      .catch((releaseErr) => {
        logger.warn("failed to release upload claim after consume error", {
          uploadId,
          error: getErrorMessage(releaseErr),
        });
      });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Proxy-upload content sink (PUT /api/uploads/_content?token=...)
// ---------------------------------------------------------------------------

export interface FsContentWriteResult {
  storageKey: string;
  size: number;
}

/**
 * Stream the body of a PUT to storage (proxy-upload path — filesystem
 * storage, and S3 storage in proxy mode). Token verification + header checks
 * happen in the route handler — this pipes the request body to the backend
 * through a counting transform, never buffering the payload in memory (FS
 * writes chunk-by-chunk to disk; S3 runs a bounded-memory multipart upload).
 *
 * Size binding: `maxSize` carries the token's signed size (`s`). For every
 * platform-minted token this is the EXACT declared byte count (`createUpload`
 * signs `min(size, maxSize) === size`), so it is enforced in both directions:
 *   - ceiling WHILE streaming — the transform errors the pipe as soon as the
 *     byte count exceeds it, which aborts the write and rolls back the
 *     partial object (FS unlinks its own O_EXCL-created destination; S3
 *     aborts the multipart upload). A Content-Length pre-check alone would be
 *     bypassable via chunked transfer encoding;
 *   - exact match AFTER streaming — a completed body SHORTER than declared is
 *     rejected and the just-written object removed, so the still-valid token
 *     stays usable for a clean retry. This mirrors what direct-presign S3
 *     mode gets by signing Content-Length (and S3 presigned-POST's
 *     `content-length-range`), instead of deferring the mismatch to
 *     consume time. `maxSize = 0` (legacy/unbounded tokens) keeps
 *     ceiling-only semantics.
 *
 * Deadline: `expiresAt` (the token's signed expiry, unix seconds; 0 = none)
 * is re-checked on every chunk — the route only validates it when the PUT
 * STARTS, so without this a slow-loris body trickled a byte at a time could
 * hold the socket (and an open S3 multipart upload) far past the 15-minute
 * token window.
 *
 * Atomic create-or-fail: refuses to overwrite an existing object at the same
 * storage key (O_EXCL on FS, `If-None-Match: *` on S3). The signed token is
 * valid for 15 min and could otherwise be replayed within its window to swap
 * the bytes of an already-populated upload between client PUT and
 * server-side consume.
 */
export async function writeProxyUploadContent(
  storageKey: string,
  body: ReadableStream<Uint8Array>,
  maxSize: number,
  expiresAt = 0,
): Promise<FsContentWriteResult> {
  const [bucket, ...rest] = storageKey.split("/");
  if (!bucket || rest.length === 0) throw invalidRequest("invalid storage key");
  const path = rest.join("/");
  let bytes = 0;
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (expiresAt > 0 && Date.now() / 1000 > expiresAt) {
        controller.error(unauthorized("upload token expired while the body was streaming"));
        return;
      }
      bytes += chunk.byteLength;
      if (maxSize > 0 && bytes > maxSize) {
        controller.error(invalidRequest(`body exceeds signed max ${maxSize} bytes`));
        return;
      }
      controller.enqueue(chunk);
    },
  });
  try {
    await storageUploadStream(bucket, path, body.pipeThrough(counter), { exclusive: true });
  } catch (err) {
    if (err instanceof StorageAlreadyExistsError) {
      throw conflict("upload_already_written", "upload content has already been written");
    }
    throw err;
  }
  if (maxSize > 0 && bytes !== maxSize) {
    // Exact-size binding (see doc comment): the object was created but is
    // shorter than the declared size — remove it so the token can be reused
    // for a clean retry instead of the mismatch surfacing at consume time.
    try {
      await storageDelete(bucket, path);
    } catch {
      // Best-effort: a leftover short object still fails the consume-time
      // size re-check; GC sweeps it with the expired upload row.
    }
    throw invalidRequest(`body is ${bytes} bytes but the signed size is ${maxSize}`);
  }
  return { storageKey, size: bytes };
}

// ---------------------------------------------------------------------------
// GC
// ---------------------------------------------------------------------------

/**
 * Delete uploads that are no longer needed:
 *   - expired AND never consumed (user never finished the PUT, or declared
 *     MIME was wrong and they abandoned the flow), OR
 *   - first consumed more than the reuse window (`UPLOAD_RETENTION_HOURS`)
 *     ago. Consumed uploads keep their storage object so the URI stays
 *     re-consumable (re-trigger after cancel, `rerun_from`); this sweep is
 *     the deleter of record for those retained bytes.
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
    const consumedCutoff = new Date(now.getTime() - consumedRetentionMs());
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
            error: getErrorMessage(err),
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
          error: getErrorMessage(err),
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
