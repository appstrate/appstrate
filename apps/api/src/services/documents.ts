// SPDX-License-Identifier: Apache-2.0

/**
 * Documents service — the durable, first-class document store.
 *
 * A `documents` row is the source of truth for a stored object, addressed by
 * the opaque `document://doc_xxx` URI. Two origins share the table:
 *
 *  - `user_upload` — a staged upload materialized here the first time a run (or
 *    chat session) consumes it (`createDocumentFromUpload`). The bytes move
 *    from the ephemeral `uploads` bucket to the durable `documents` bucket.
 *  - `agent_output` — a deliverable an agent published from a run (Phase 2).
 *
 * Access is never a per-file grant (D2): `getDocumentForActor` derives it from
 * the container (run read-ACL, or chat-session owner) at check time.
 * `downloadable` (whether `/content` will serve the bytes to this caller) is
 * derived, not stored: an agent output is downloadable by anyone who can read
 * the container; a user upload only by its own creator.
 *
 * Quotas (D4) are synchronous at the write: a per-file cap (413) and a per-org
 * byte quota (403 `storage_limit_exceeded`) tracked transactionally on
 * `organizations.documents_bytes_used`.
 */

import { and, eq, lt, desc, or, isNull, isNotNull, inArray, sql, type SQL } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { documents, organizations, chatSessions } from "@appstrate/db/schema";
import type { DocumentPurpose } from "@appstrate/db/schema";
import {
  uploadStream as storageUploadStream,
  downloadStream as storageDownloadStream,
  deleteFile as storageDelete,
} from "@appstrate/db/storage";
import { fileTypeStream } from "file-type";
import { getErrorMessage } from "@appstrate/core/errors";
import { getEnv } from "@appstrate/env";
import type { Actor } from "@appstrate/connect";
import type { AppScope } from "../lib/scope.ts";
import { actorInsert, actorFromIds, actorScopeFilter } from "../lib/actor.ts";
import { prefixedId } from "../lib/ids.ts";
import { logger } from "../lib/logger.ts";
import { listResponse } from "../lib/list-response.ts";
import type { ListEnvelope } from "@appstrate/shared-types";
import { invalidRequest, notFound, payloadTooLarge, storageLimitExceeded } from "../lib/errors.ts";
import type { ChatAttachmentRequest, ResolvedChatAttachment } from "@appstrate/core/chat-contract";
import { consumeUploadStream, peekUploads, sanitizeFilename, parseUploadUri } from "./uploads.ts";
import { sanitizeStorageKey } from "./file-storage.ts";
import { getRun } from "./state/runs.ts";
import { synthesiseFinalize } from "./run-event-ingestion.ts";
import { recordAudit } from "./audit.ts";
import {
  signPreviewToken,
  previewKind,
  type PreviewKind,
  PREVIEW_TOKEN_TTL_SECONDS,
} from "./document-preview.ts";
import {
  DOCUMENT_URI_PREFIX,
  DOCUMENT_ID_RE,
  isDocumentUri,
  parseDocumentUri,
  documentUri,
} from "@appstrate/core/document-uri";

/** Durable documents bucket (distinct from the ephemeral `uploads` bucket). */
export const DOCUMENTS_BUCKET = "documents";

// Canonical `document://` URI contract lives in @appstrate/core/document-uri
// (shared with the MCP router, the chat module, and the runtime). Re-exported
// here to preserve this service's public surface.
export { DOCUMENT_URI_PREFIX, isDocumentUri, parseDocumentUri, documentUri };

/**
 * Split a `bucket/path/to/object` storage key into its `{ bucket, path }` parts,
 * or null when the key is malformed (no bucket, or no path after it). One parser
 * for every consumer (delete, stream, content route) so the split lives in one
 * place.
 */
export function parseStorageKey(storageKey: string): { bucket: string; path: string } | null {
  const [bucket, ...rest] = storageKey.split("/");
  if (!bucket || rest.length === 0) return null;
  return { bucket, path: rest.join("/") };
}

/**
 * Best-effort delete of a document's storage object by its `bucket/path` inside
 * {@link DOCUMENTS_BUCKET}. Swallows + logs any failure (a leftover object is
 * harmless — the org byte counter is the source of truth, reconciled by the GC).
 * One helper for every drop-on-error / drop-on-dedup site.
 */
async function dropDocumentObject(storagePath: string, reason: string): Promise<void> {
  await storageDelete(DOCUMENTS_BUCKET, storagePath).catch((err) => {
    logger.warn("failed to delete documents object", {
      reason,
      storagePath,
      error: getErrorMessage(err),
    });
  });
}

/**
 * Storage path (inside {@link DOCUMENTS_BUCKET}) a document's bytes live at:
 * `{applicationId}/{documentId}/{safeName}`. One builder so the layout is
 * defined once.
 */
function documentStoragePath(scope: AppScope, documentId: string, name: string): string {
  const safeName = sanitizeStorageKey(sanitizeFilename(name));
  return `${scope.applicationId}/${documentId}/${safeName}`;
}

/** The 413 message for a file exceeding the per-file cap. */
function perFileCapMessage(cap: number): string {
  return `Document exceeds the per-file limit of ${cap} bytes`;
}

/** The 413 message for a run's output overrunning the per-run cap. */
function runOutputCapMessage(cap: number): string {
  return `Run output would exceed the per-run limit of ${cap} bytes`;
}

/** A Drizzle executor — either the root `db` or an open transaction handle. */
type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Which container a materialized upload is anchored to. */
export type DocumentContainer = { runId: string } | { chatSessionId: string };

/**
 * A staged upload that the input-parser has already rewritten to
 * `document://<documentId>` in the persisted run input, to be materialized into
 * a durable `documents` row once the run row exists (`documents.run_id` FK).
 */
export interface PendingUploadMaterialization {
  uploadId: string;
  documentId: string;
}

/** A stored document row (internal shape — carries `storageKey` for I/O). */
export interface DocumentRow {
  id: string;
  orgId: string;
  applicationId: string;
  purpose: DocumentPurpose;
  runId: string | null;
  chatSessionId: string | null;
  packageId: string | null;
  userId: string | null;
  endUserId: string | null;
  storageKey: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  expiresAt: Date | null;
  createdAt: Date;
}

/** A document resolved for a caller, with the derived `downloadable` flag. */
export interface ResolvedDocument {
  row: DocumentRow;
  downloadable: boolean;
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/**
 * Derive whether `/content` serves the bytes to `actor` (D2 / Anthropic rule):
 * an `agent_output` is downloadable by anyone who can read the container; a
 * `user_upload` only by its own creator — so an upload is never re-served to
 * other actors via the API (kills the CDN-abuse vector). Pure.
 */
export function deriveDownloadable(
  doc: { purpose: DocumentPurpose; userId: string | null; endUserId: string | null },
  actor: Actor,
): boolean {
  if (doc.purpose === "agent_output") return true;
  return actor.type === "user" ? doc.userId === actor.id : doc.endUserId === actor.id;
}

/**
 * Would adding `addBytes` to `used` exceed `quota`? `undefined` quota = no
 * limit (OSS default). Pure — the org-quota math in one place. Equality is
 * allowed (a write that lands exactly on the quota succeeds).
 */
export function wouldExceedOrgQuota(
  used: number,
  addBytes: number,
  quota: number | undefined,
): boolean {
  if (quota === undefined) return false;
  return used + addBytes > quota;
}

/**
 * Throw the 403 `storage_limit_exceeded` when writing `addBytes` on top of
 * `used` would overrun the org's `ORG_STORAGE_QUOTA_BYTES`. The org-quota
 * rejection in one place (pre-flight fast reject + FOR UPDATE re-check).
 */
function assertWithinOrgQuota(used: number, addBytes: number): void {
  const quota = getEnv().ORG_STORAGE_QUOTA_BYTES;
  if (wouldExceedOrgQuota(used, addBytes, quota)) {
    throw storageLimitExceeded(`Organization storage quota (${quota} bytes) would be exceeded`);
  }
}

/**
 * `expiresAt` a fresh document is stamped with, from `DOCUMENT_RETENTION_DAYS`.
 * Undefined ⇒ permanent (null column). Pure given `now`.
 */
export function retentionExpiry(retentionDays: number | undefined, now = new Date()): Date | null {
  if (retentionDays === undefined) return null;
  return new Date(now.getTime() + retentionDays * 24 * 60 * 60 * 1000);
}

/** Mid-stream byte ceilings for {@link createHashingCounter}. */
export interface HashingCounterCaps {
  perFileCap: number;
  runOutputCap: number;
  runOutputUsed: number;
}

/**
 * A pass-through TransformStream that counts bytes and computes their SHA-256
 * as they flow, without buffering. Pipe the source through `.stream` into the
 * destination sink; read `{bytes, sha256}` from `.result()` once the stream has
 * fully drained (memoized — the digest is finalized on first read, so call it
 * only after the pipe resolves). Exported so the streaming-hash contract is
 * unit-testable in isolation.
 *
 * When `caps` is supplied, the stream also enforces byte ceilings mid-stream —
 * the per-file cap and the run's remaining output budget. As soon as either is
 * exceeded the stream errors (aborting the S3 write so no full object lands),
 * with a distinct {@link payloadTooLarge} message per limit so the caller
 * surfaces the right 413. Used by the agent-output ingestion path, which has no
 * declared size to pre-check. Without `caps` it just counts + hashes.
 */
export function createHashingCounter(caps?: HashingCounterCaps): {
  stream: TransformStream<Uint8Array, Uint8Array>;
  result: () => { bytes: number; sha256: string };
} {
  const hasher = new Bun.CryptoHasher("sha256");
  const runRemaining = caps ? caps.runOutputCap - caps.runOutputUsed : Infinity;
  let bytes = 0;
  let digest: string | null = null;
  const stream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (caps) {
        if (bytes > caps.perFileCap) {
          controller.error(payloadTooLarge(perFileCapMessage(caps.perFileCap)));
          return;
        }
        if (bytes > runRemaining) {
          controller.error(payloadTooLarge(runOutputCapMessage(caps.runOutputCap)));
          return;
        }
      }
      hasher.update(chunk);
      controller.enqueue(chunk);
    },
  });
  return {
    stream,
    result: () => {
      digest ??= hasher.digest("hex");
      return { bytes, sha256: digest };
    },
  };
}

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

/**
 * Wire shape for a document. Field casing follows CASING_CONVENTIONS.md
 * carve-out 4b (universal DB-convention fields stay camelCase EVERYWHERE):
 * `applicationId`, `packageId`, `createdAt`, `expiresAt` are on that exact list.
 * `run_id` / `chat_session_id` are NOT on it (the list carves out `scheduleId`,
 * `apiKeyId`, `endUserId` but deliberately not `runId`), so they stay snake_case
 * as domain fields — matching the `notification` DTO's `run_id` and the `Run`
 * DTO's treatment of non-listed `*_id` fields.
 */
export interface DocumentDto {
  object: "document";
  id: string;
  uri: string;
  purpose: DocumentPurpose;
  applicationId: string;
  run_id: string | null;
  chat_session_id: string | null;
  packageId: string | null;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  downloadable: boolean;
  /**
   * Whether this document has an in-browser preview the caller may open — a
   * previewable mime ({@link PreviewKind}) on a document the caller can read. A
   * cheap boolean carried on EVERY row (list + single GET) so the gallery can
   * show the preview affordance without minting a signed token per row (the
   * token is minted only on the single-document GET, below).
   */
  previewable: boolean;
  /**
   * How this document previews — `html` | `image` | `pdf` | `text`, or null when
   * not previewable. Carried on EVERY row so the frontend knows which render
   * path (sandboxed iframe / `<img>` / native-PDF iframe / plaintext `<pre>`) to
   * use without inspecting the mime itself. snake_case: not on the universal
   * DB-convention carve-out list.
   */
  preview_kind: PreviewKind | null;
  /**
   * Absolute URL of a hardened, cookie-less HTML preview — minted ONLY on the
   * single-document GET (never in list rows, to avoid signing a short-lived
   * token per gallery row). Non-null only for a previewable document. Carries a
   * short-lived signed token (`?t=`); the SPA loads it in an
   * `sandbox="allow-scripts"` iframe. On the `USERCONTENT_URL` origin when set,
   * else on `APP_URL`. Absent (undefined) on list rows.
   */
  preview_url?: string | null;
  expiresAt: string | null;
  createdAt: string;
}

/**
 * Mint the hardened-preview URL for a resolved document, or null when its mime
 * is not previewable ({@link previewKind}). The token authorizes a GET of THIS
 * document's preview for {@link PREVIEW_TOKEN_TTL_SECONDS}; the URL points at the
 * cookie-less preview route on `USERCONTENT_URL` (separate registrable domain —
 * strongest isolation) when configured, else same-origin on `APP_URL`. Called
 * only after the container ACL already resolved the row for the caller, so
 * presence of a URL is itself the "previewable by you" signal.
 */
function mintPreviewUrl(row: DocumentRow, actor: Actor): string | null {
  if (previewKind(row.mime) === null) return null;
  const env = getEnv();
  const exp = Math.floor(Date.now() / 1000) + PREVIEW_TOKEN_TTL_SECONDS;
  // Bind the minting actor into the token (defense-in-depth for S1): the
  // preview route re-checks it against the document's creator for a
  // `user_upload`, so a hand-crafted token for another member's private
  // upload is refused even if it verifies.
  const creator = actorInsert(actor);
  const token = signPreviewToken(
    { d: row.id, o: row.orgId, e: exp, u: creator.userId, eu: creator.endUserId },
    env.UPLOAD_SIGNING_SECRET,
  );
  let base = env.USERCONTENT_URL ?? env.APP_URL;
  while (base.endsWith("/")) base = base.slice(0, -1);
  return `${base}/preview/documents/${row.id}?t=${encodeURIComponent(token)}`;
}

/**
 * Serialize a resolved document row to its wire DTO. `downloadable` is passed in
 * (the caller already derived it via {@link getDocumentForActor} /
 * {@link deriveDownloadable}) rather than re-derived here. `mintPreview` mints
 * the signed `preview_url` — set ONLY on the single-document GET, never in list
 * rows (a list of N rows must not sign N short-lived tokens). `previewable` (a
 * plain boolean) rides every row so the gallery still shows the preview
 * affordance. `downloadable` gates BOTH the bytes and the preview: a
 * `user_upload` is creator-only content (D2/S1), so a member who can merely
 * resolve the container is neither told it is previewable nor handed a token.
 */
export function toDocumentDto(
  row: DocumentRow,
  actor: Actor,
  downloadable: boolean,
  opts: { mintPreview?: boolean } = {},
): DocumentDto {
  const kind = previewKind(row.mime);
  // `downloadable` gates the preview: a `user_upload` the caller cannot download
  // is neither advertised as previewable nor assigned a kind (D2/S1).
  const previewable = downloadable && kind !== null;
  return {
    object: "document",
    id: row.id,
    uri: documentUri(row.id),
    purpose: row.purpose,
    applicationId: row.applicationId,
    run_id: row.runId,
    chat_session_id: row.chatSessionId,
    packageId: row.packageId,
    name: row.name,
    mime: row.mime,
    size: row.size,
    sha256: row.sha256,
    downloadable,
    previewable,
    preview_kind: previewable ? kind : null,
    ...(opts.mintPreview ? { preview_url: previewable ? mintPreviewUrl(row, actor) : null } : {}),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Create (materialize a staged upload into a durable document)
// ---------------------------------------------------------------------------

/**
 * Materialize a staged upload into a durable document: stream the upload bucket
 * → documents bucket (computing sha256 on the fly), then insert the row and
 * increment the org's byte counter in one transaction.
 *
 * Reuses {@link consumeUploadStream} for the byte-count + magic-byte MIME
 * validation (no duplication of that logic here); the sink pipes the bytes into
 * the documents bucket and hashes them. The S3 write completes BEFORE the DB
 * commit — so on any DB failure the just-written object is deleted (mirrors the
 * first-consume rollback in `uploads.ts`), never leaving an orphan whose bytes
 * were counted against no row.
 *
 * Quotas are synchronous: the per-file cap and org quota are checked on the
 * declared size before streaming (fast reject), then re-checked on the exact
 * byte count inside the transaction with the org row locked `FOR UPDATE`.
 */
export async function createDocumentFromUpload(
  scope: AppScope,
  actor: Actor,
  uploadId: string,
  container: DocumentContainer,
  opts: { documentId?: string; packageId?: string | null } = {},
): Promise<DocumentRow> {
  const env = getEnv();
  const documentId = opts.documentId ?? prefixedId("doc");

  // Declared-size pre-check: reject an over-cap / over-quota upload before
  // streaming a single byte. `peekUploads` also validates tenant + expiry
  // (same not-found / gone shapes as consume).
  const [meta] = (await peekUploads([uploadId], scope)).values();
  await assertWithinDocumentLimits(scope.orgId, [meta!.size]);

  const storagePath = documentStoragePath(scope, documentId, meta!.name);

  // Stream upload → documents bucket, hashing + counting on the fly. The sink's
  // returned `{bytes, sniffedMime}` feed consume's size + MIME validation.
  const digester = createHashingCounter();
  try {
    await consumeUploadStream(uploadId, scope, async (src) => {
      const detection = await fileTypeStream(src);
      await storageUploadStream(
        DOCUMENTS_BUCKET,
        storagePath,
        detection.pipeThrough(digester.stream),
        { exclusive: true },
      );
      return { bytes: digester.result().bytes, sniffedMime: detection.fileType?.mime };
    });
  } catch (err) {
    // The doc object may have been (partially) written before the throw
    // (size/MIME mismatch is validated post-drain). Drop it so the counter and
    // storage never disagree; consume already rolled back the upload side.
    await dropDocumentObject(storagePath, "materialize error");
    throw err;
  }

  const { bytes: byteCount, sha256 } = digester.result();

  return commitDocumentRow({
    scope,
    documentId,
    storagePath,
    purpose: "user_upload",
    runId: "runId" in container ? container.runId : null,
    chatSessionId: "chatSessionId" in container ? container.chatSessionId : null,
    packageId: opts.packageId ?? null,
    attribution: actorInsert(actor),
    name: meta!.name,
    mime: meta!.mime,
    byteCount,
    sha256,
    expiresAt: retentionExpiry(env.DOCUMENT_RETENTION_DAYS),
  });
}

/**
 * Commit a just-streamed document object into a durable `documents` row: the
 * FOR UPDATE org-quota re-check + row insert + byte-counter increment run in
 * one transaction, and on any failure the storage object is dropped so its
 * bytes are never stranded uncounted in the bucket. Shared by
 * {@link createDocumentFromUpload} (staged-upload materialization) and
 * {@link createDocumentFromStream} (agent-output ingestion) so the quota
 * transaction + audit live in exactly one place.
 */
async function commitDocumentRow(params: {
  scope: AppScope;
  documentId: string;
  /** Path inside {@link DOCUMENTS_BUCKET} the bytes were streamed to. */
  storagePath: string;
  purpose: DocumentPurpose;
  runId: string | null;
  chatSessionId: string | null;
  packageId: string | null;
  attribution: { userId: string | null; endUserId: string | null };
  name: string;
  mime: string;
  byteCount: number;
  sha256: string;
  expiresAt: Date | null;
  /**
   * Per-run output ceiling ({@link createDocumentFromStream} only). When set,
   * the run's `agent_output` total is re-summed under the same org `FOR UPDATE`
   * lock and this file is rejected (413) if it would overrun the cap — closing
   * the race where concurrent publishes each pass the pre-stream check on a
   * stale total.
   */
  runOutputCap?: number;
}): Promise<DocumentRow> {
  const { scope, documentId, storagePath, byteCount, attribution } = params;
  try {
    const [row] = await db.transaction(async (tx) => {
      // Lock the org row so a concurrent write cannot both pass the quota
      // re-check on a stale `used`. Exact byte count re-checked here.
      const [orgLocked] = await tx
        .select({ used: organizations.documentsBytesUsed })
        .from(organizations)
        .where(eq(organizations.id, scope.orgId))
        .for("update")
        .limit(1);
      assertWithinOrgQuota(orgLocked?.used ?? 0, byteCount);
      // Per-run cap re-check under the same lock (agent-output ingestion). The
      // org `FOR UPDATE` above serialises every commit for this org — so two
      // concurrent publishes to the same run each observe the other's already-
      // committed row here, and their combined total is bounded exactly.
      if (params.runOutputCap !== undefined && params.runId && params.purpose === "agent_output") {
        const runTotal = await runOutputBytesUsed(tx, scope, params.runId);
        if (runTotal + byteCount > params.runOutputCap) {
          throw payloadTooLarge(runOutputCapMessage(params.runOutputCap));
        }
      }
      const inserted = await tx
        .insert(documents)
        .values({
          id: documentId,
          orgId: scope.orgId,
          applicationId: scope.applicationId,
          purpose: params.purpose,
          runId: params.runId,
          chatSessionId: params.chatSessionId,
          packageId: params.packageId,
          userId: attribution.userId,
          endUserId: attribution.endUserId,
          storageKey: `${DOCUMENTS_BUCKET}/${storagePath}`,
          name: params.name,
          mime: params.mime,
          size: byteCount,
          sha256: params.sha256,
          expiresAt: params.expiresAt,
        })
        .returning();
      await tx
        .update(organizations)
        .set({ documentsBytesUsed: sql`${organizations.documentsBytesUsed} + ${byteCount}` })
        .where(eq(organizations.id, scope.orgId));
      return inserted;
    });
    // Best-effort audit — `recordAudit` swallows its own failures. Emitted from
    // the service (not a route) because these writes run without a request
    // context (materialization behind `createRun`; agent-output ingestion is
    // HMAC-run-authenticated, not a user session).
    const auditActor = actorFromIds(attribution.userId, attribution.endUserId);
    await recordAudit({
      orgId: scope.orgId,
      applicationId: scope.applicationId,
      actorType: auditActor ? auditActor.type : "system",
      actorId: auditActor?.id ?? null,
      action: "document.created",
      resourceType: "document",
      resourceId: documentId,
      after: { name: params.name, size: byteCount, mime: params.mime, purpose: params.purpose },
    });
    return row as DocumentRow;
  } catch (err) {
    // DB failed after the bytes landed — drop the object so its bytes are not
    // stranded uncounted in the bucket.
    await dropDocumentObject(storagePath, "row-insert failure");
    throw err;
  }
}

/**
 * Sum the bytes of the `agent_output` documents a run has already published —
 * the running total the per-run output cap ({@link createDocumentFromStream})
 * checks the incoming file against.
 */
async function runOutputBytesUsed(
  executor: DbOrTx,
  scope: AppScope,
  runId: string,
): Promise<number> {
  const [row] = await executor
    .select({ total: sql<string>`COALESCE(SUM(${documents.size}), 0)` })
    .from(documents)
    .where(
      and(
        eq(documents.runId, runId),
        eq(documents.orgId, scope.orgId),
        eq(documents.purpose, "agent_output"),
      ),
    );
  return Number(row?.total ?? 0);
}

/** The outcome of an agent-output ingestion: the row plus whether it deduped. */
export interface CreatedDocumentFromStream {
  row: DocumentRow;
  /** True when an identical (run, sha256, name) document already existed. */
  deduped: boolean;
}

/**
 * Postgres unique_violation (SQLSTATE 23505). Walks the `cause` chain since
 * Drizzle wraps the driver error in a `DrizzleQueryError` whose own `code` is
 * undefined (same pattern as `isInvalidTextRepresentation` in db-helpers.ts).
 */
function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; current != null && depth < 5; depth++) {
    if (typeof current !== "object") break;
    if ((current as { code?: unknown }).code === "23505") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * The existing `agent_output` document a re-published (run, sha256, name) tuple
 * dedups against — the same key the partial unique index enforces. Used both as
 * the fast-path pre-commit check and to recover the winner's row after losing a
 * concurrent-insert race.
 */
async function findDedupDocument(
  scope: AppScope,
  runId: string,
  sha256: string,
  name: string,
): Promise<DocumentRow | null> {
  const [existing] = await db
    .select(documentSelect)
    .from(documents)
    .where(
      and(
        eq(documents.runId, runId),
        eq(documents.orgId, scope.orgId),
        eq(documents.applicationId, scope.applicationId),
        eq(documents.purpose, "agent_output"),
        eq(documents.sha256, sha256),
        eq(documents.name, name),
      ),
    )
    .limit(1);
  return (existing as DocumentRow) ?? null;
}

/**
 * Ingest an agent-published document from a run's streaming request body into a
 * durable `agent_output` document. Mirrors {@link createDocumentFromUpload} but
 * for the run→platform channel: the bytes arrive as a raw stream (no staged
 * upload), so the caps are enforced mid-stream via {@link createHashingCounter}'s
 * `caps` (per-file + per-run output budget, both 413) and the org quota +
 * counter are committed transactionally via the shared {@link commitDocumentRow}.
 *
 * Idempotent for the sweep's at-least-once retries: if this run already
 * published a document with the SAME sha256 AND name, the just-streamed object
 * is dropped and the existing row returned (`deduped: true`) rather than storing
 * the bytes twice. Two layers enforce this: a fast-path pre-commit SELECT, and —
 * for the concurrent-publish race where both callers pass that SELECT — the
 * partial unique index `(run_id, sha256, name) WHERE purpose = 'agent_output'`,
 * whose violation the commit path catches and resolves to the same dedup (200).
 */
export async function createDocumentFromStream(
  scope: AppScope,
  runId: string,
  attribution: { userId: string | null; endUserId: string | null },
  packageId: string | null,
  input: { name: string; mime: string; body: ReadableStream<Uint8Array> },
): Promise<CreatedDocumentFromStream> {
  const env = getEnv();
  const documentId = prefixedId("doc");
  const storagePath = documentStoragePath(scope, documentId, input.name);

  const runOutputUsed = await runOutputBytesUsed(db, scope, runId);
  const digester = createHashingCounter({
    perFileCap: env.DOCUMENT_MAX_FILE_BYTES,
    runOutputCap: env.RUN_MAX_OUTPUT_BYTES,
    runOutputUsed,
  });

  try {
    await storageUploadStream(
      DOCUMENTS_BUCKET,
      storagePath,
      input.body.pipeThrough(digester.stream),
      {
        exclusive: true,
      },
    );
  } catch (err) {
    // Cap tripped mid-stream (or a transient storage error) — the object may
    // have been partially written before the abort. Drop it so a cut-short
    // upload never leaves a partial object behind (the 413 delete-on-short
    // contract) nor strands bytes uncounted.
    await dropDocumentObject(storagePath, "stream error");
    throw err;
  }

  const { bytes: byteCount, sha256 } = digester.result();

  // Dedup fast path: an identical (run, sha256, name) agent_output already
  // exists — the sweep re-published a file the tool already stored, or a retried
  // POST. Drop the freshly-written object and return the existing row.
  const existing = await findDedupDocument(scope, runId, sha256, input.name);
  if (existing) {
    await dropDocumentObject(storagePath, "duplicate");
    return { row: existing, deduped: true };
  }

  try {
    const row = await commitDocumentRow({
      scope,
      documentId,
      storagePath,
      purpose: "agent_output",
      runId,
      chatSessionId: null,
      packageId,
      attribution,
      name: input.name,
      mime: input.mime,
      byteCount,
      sha256,
      expiresAt: retentionExpiry(env.DOCUMENT_RETENTION_DAYS),
      // Authoritative per-run cap re-check under the org lock (the pre-stream
      // `runOutputUsed` read above is only the fast reject — see commitDocumentRow).
      runOutputCap: env.RUN_MAX_OUTPUT_BYTES,
    });
    return { row, deduped: false };
  } catch (err) {
    // Lost the concurrent-insert race: another publish committed the same
    // (run, sha256, name) between our SELECT and INSERT, so the partial unique
    // index rejected ours. commitDocumentRow already dropped OUR object; recover
    // the winner's row and return it as the dedup case (never double-counts).
    if (isUniqueViolation(err)) {
      const winner = await findDedupDocument(scope, runId, sha256, input.name);
      if (winner) return { row: winner, deduped: true };
    }
    throw err;
  }
}

function assertWithinFileCap(size: number, cap: number): void {
  if (size > cap) {
    throw payloadTooLarge(perFileCapMessage(cap));
  }
}

/**
 * Synchronous document-quota gate on DECLARED sizes — the per-file cap (413)
 * per size and the org byte quota (403) against the running
 * `documents_bytes_used`. Shared by `createDocumentFromUpload` (single size,
 * before it streams) and the input-parser pre-flight (the run's whole upload
 * set, before the run launches), so the quota math lives in one place. The
 * authoritative exact-byte re-check stays inside `createDocumentFromUpload`'s
 * `FOR UPDATE` transaction — this is the fast, pre-write reject.
 */
export async function assertWithinDocumentLimits(orgId: string, sizes: number[]): Promise<void> {
  const env = getEnv();
  for (const size of sizes) assertWithinFileCap(size, env.DOCUMENT_MAX_FILE_BYTES);
  if (env.ORG_STORAGE_QUOTA_BYTES === undefined || sizes.length === 0) return;
  const total = sizes.reduce((sum, s) => sum + s, 0);
  const [org] = await db
    .select({ used: organizations.documentsBytesUsed })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  assertWithinOrgQuota(org?.used ?? 0, total);
}

/**
 * Materialize the uploads the input-parser deferred, now that the run row
 * exists. Runs after `createRun` inside `prepareAndExecuteRun`. Each is anchored
 * to the run with the pre-minted document id the persisted input already
 * references (`document://<documentId>`).
 *
 * The common rejections (over-quota, over-cap) are pre-flighted in the
 * input-parser before `createRun`, so a failure here is a rare I/O error. It
 * must NOT be swallowed: the persisted run input references these document ids,
 * so a half-materialized run is a broken state. On any error we roll back the
 * documents already created for this run, mark the run failed with a clear
 * reason, and rethrow so the route surfaces the real error to the caller.
 */
export async function materializeRunUploads(
  scope: AppScope,
  actor: Actor,
  runId: string,
  packageId: string | null,
  pending: PendingUploadMaterialization[],
): Promise<void> {
  const created: string[] = [];
  try {
    for (const { uploadId, documentId } of pending) {
      await createDocumentFromUpload(scope, actor, uploadId, { runId }, { documentId, packageId });
      created.push(documentId);
    }
  } catch (err) {
    // Roll back the partial batch so no document row the persisted input
    // references is left half-created (or its bytes counted against the org).
    for (const documentId of created) {
      await deleteDocument(scope, documentId).catch((cleanupErr) => {
        logger.warn("failed to roll back materialized document after run failure", {
          runId,
          documentId,
          error: getErrorMessage(cleanupErr),
        });
      });
    }
    // Fail the run loudly rather than leaving it pointing at documents it never
    // got — a clear terminal beats a silently broken run. Route through the
    // canonical convergence point (`synthesiseFinalize` → `finalizeRun`) so the
    // `afterRun`/billing hooks fire like any other terminal transition, instead
    // of writing `runs.status` directly. The run has not launched its container
    // yet (createRun already stamped the sink secret), so this is a clean failed
    // finalize.
    await synthesiseFinalize(runId, {
      status: "failed",
      error: { message: "Failed to persist input documents" },
    }).catch((finErr) => {
      logger.warn("failed to mark run failed after materialization error", {
        runId,
        error: getErrorMessage(finErr),
      });
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Read (ACL inherited from the container)
// ---------------------------------------------------------------------------

const documentSelect = {
  id: documents.id,
  orgId: documents.orgId,
  applicationId: documents.applicationId,
  purpose: documents.purpose,
  runId: documents.runId,
  chatSessionId: documents.chatSessionId,
  packageId: documents.packageId,
  userId: documents.userId,
  endUserId: documents.endUserId,
  storageKey: documents.storageKey,
  name: documents.name,
  mime: documents.mime,
  size: documents.size,
  sha256: documents.sha256,
  expiresAt: documents.expiresAt,
  createdAt: documents.createdAt,
} as const;

/**
 * Resolve a document for `actor`, enforcing the container's read-ACL (D2).
 * Returns `null` (→ 404 at the route) when the document does not exist in the
 * caller's org+app, or when the container's ACL rejects the actor — a
 * cross-org, cross-app, or cross-actor id is indistinguishable from a missing
 * one. `downloadable` is derived for the `/content` gate.
 */
export async function getDocumentForActor(
  scope: AppScope,
  actor: Actor,
  docId: string,
): Promise<ResolvedDocument | null> {
  if (!DOCUMENT_ID_RE.test(docId)) return null;
  const [row] = await db
    .select(documentSelect)
    .from(documents)
    .where(
      and(
        eq(documents.id, docId),
        eq(documents.orgId, scope.orgId),
        eq(documents.applicationId, scope.applicationId),
      ),
    )
    .limit(1);
  if (!row) return null;

  if (row.runId) {
    // Run container: reuse the run's read semantics (org+app scope already
    // matched above) plus the end-user guard (routes/runs.ts pattern).
    const run = await getRun(scope, row.runId);
    if (!run) return null;
    if (actor.type === "end_user" && run.endUserId !== actor.id) return null;
  } else if (row.chatSessionId) {
    // Chat container: sessions are per-dashboard-user; only the owner reads.
    if (actor.type !== "user") return null;
    const [session] = await db
      .select({ userId: chatSessions.userId })
      .from(chatSessions)
      .where(and(eq(chatSessions.id, row.chatSessionId), eq(chatSessions.orgId, scope.orgId)))
      .limit(1);
    if (!session || session.userId !== actor.id) return null;
  }

  return { row: row as DocumentRow, downloadable: deriveDownloadable(row, actor) };
}

/**
 * Load a document row by id, scoped to `orgId` only — for the cookie-less
 * preview route, whose signed token IS the authorization (no session actor, no
 * container ACL re-check: the token was minted by `getDocumentForActor` having
 * already resolved the row for a caller). Binding to the token's `orgId` means a
 * token whose tenant does not match the stored row resolves to null (→ 404).
 * Returns null for a malformed id or a miss.
 */
export async function loadDocumentForPreview(
  orgId: string,
  docId: string,
): Promise<DocumentRow | null> {
  if (!DOCUMENT_ID_RE.test(docId)) return null;
  const [row] = await db
    .select(documentSelect)
    .from(documents)
    .where(and(eq(documents.id, docId), eq(documents.orgId, orgId)))
    .limit(1);
  return (row as DocumentRow) ?? null;
}

/**
 * Resolve a chat composer file attachment to a durable `document://` URI + its
 * metadata (the seam behind `PlatformServices.resolveChatAttachment`, wired for
 * the chat module which has no DB access):
 *
 *  - `upload://upl_x` → materialize it into a chat-session-scoped document
 *    (purpose `user_upload`, attributed to the session owner) and return the new
 *    `document://` URI. Quota/cap rejections propagate as RFC 9457 errors.
 *  - `document://doc_x` → validate the session owner can read it (container ACL)
 *    and echo it back; a foreign/missing document is a 404.
 *
 * Chat sessions are per dashboard user, so the actor is always a `user`.
 */
export async function resolveChatAttachment(
  request: ChatAttachmentRequest,
): Promise<ResolvedChatAttachment> {
  const scope: AppScope = { orgId: request.orgId, applicationId: request.applicationId };
  const actor: Actor = { type: "user", id: request.userId };

  if (isDocumentUri(request.uri)) {
    const docId = parseDocumentUri(request.uri);
    if (!docId) throw invalidRequest(`Malformed document URI '${request.uri}'`);
    const resolved = await getDocumentForActor(scope, actor, docId);
    if (!resolved) throw notFound(`Document '${docId}' not found`);
    const { row } = resolved;
    return { uri: documentUri(row.id), name: row.name, mime: row.mime, size: row.size };
  }

  const uploadId = parseUploadUri(request.uri);
  if (!uploadId) {
    throw invalidRequest(`Attachment URI must be an 'upload://' or 'document://' URI`);
  }
  const row = await createDocumentFromUpload(scope, actor, uploadId, {
    chatSessionId: request.chatSessionId,
  });
  return { uri: documentUri(row.id), name: row.name, mime: row.mime, size: row.size };
}

// ---------------------------------------------------------------------------
// List (gallery)
// ---------------------------------------------------------------------------

export interface ListDocumentsFilters {
  purpose?: DocumentPurpose;
  packageId?: string;
  runId?: string;
  chatSessionId?: string;
  limit?: number;
  startingAfter?: string;
}

/**
 * Org+app-scoped document gallery, with container-inherited visibility (D7 —
 * consistent with `getDocumentForActor`):
 *
 *  - A dashboard `user` (member) sees every run-contained document in the app
 *    (mirroring the org-wide runs list — no per-user filter), plus chat-contained
 *    documents only from their OWN sessions (chat sessions are private).
 *  - An `end_user` sees only their own rows (`actorScopeFilter`).
 *
 * Keyset pagination on `(createdAt, id)` DESC — the same stable tuple cursor as
 * the end-users list.
 */
export async function listDocumentsForActor(
  scope: AppScope,
  actor: Actor,
  filters: ListDocumentsFilters = {},
): Promise<ListEnvelope<DocumentDto>> {
  const limit = Math.min(Math.max(filters.limit ?? 20, 1), 100);
  const fetchLimit = limit + 1;

  const conditions: SQL[] = [
    eq(documents.orgId, scope.orgId),
    eq(documents.applicationId, scope.applicationId),
    actor.type === "end_user"
      ? actorScopeFilter(actor, { userId: documents.userId, endUserId: documents.endUserId })
      : // Members: all run-contained docs; chat-contained only from own sessions
        // (chat docs carry their session owner as `userId`).
        or(isNull(documents.chatSessionId), eq(documents.userId, actor.id))!,
  ];
  if (filters.purpose) conditions.push(eq(documents.purpose, filters.purpose));
  if (filters.packageId) conditions.push(eq(documents.packageId, filters.packageId));
  if (filters.runId) conditions.push(eq(documents.runId, filters.runId));
  if (filters.chatSessionId) conditions.push(eq(documents.chatSessionId, filters.chatSessionId));

  if (filters.startingAfter) {
    const [cursor] = await db
      .select({ createdAt: documents.createdAt, id: documents.id })
      .from(documents)
      .where(
        and(
          eq(documents.id, filters.startingAfter),
          eq(documents.orgId, scope.orgId),
          eq(documents.applicationId, scope.applicationId),
        ),
      )
      .limit(1);
    // Next page (older rows), DESC order: (createdAt, id) < (cursor.createdAt, cursor.id).
    // A cursor id that no longer exists drops its clause — the page just starts
    // at the head rather than erroring.
    if (cursor) {
      conditions.push(
        or(
          lt(documents.createdAt, cursor.createdAt),
          and(eq(documents.createdAt, cursor.createdAt), lt(documents.id, cursor.id)),
        )!,
      );
    }
  }

  const rows = await db
    .select(documentSelect)
    .from(documents)
    .where(and(...conditions))
    .orderBy(desc(documents.createdAt), desc(documents.id))
    .limit(fetchLimit);

  const hasMore = rows.length > limit;
  const data = (hasMore ? rows.slice(0, limit) : rows).map((r) => {
    const row = r as DocumentRow;
    // No `mintPreview` — list rows carry only the `previewable` boolean; the
    // signed preview token is minted on the single-document GET.
    return toDocumentDto(row, actor, deriveDownloadable(row, actor));
  });
  return { ...listResponse(data, { hasMore }), limit };
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/**
 * Delete a document: drop the storage object, delete the row, and decrement the
 * org counter — the counter decrement + row delete are one transaction, the
 * storage delete is best-effort (a leftover object is harmless: the org byte
 * counter is the source of truth for the quota, kept honest by the periodic
 * counter reconciliation, and a stray object is never re-counted). Authorization
 * (owner/admin permission OR creator) is enforced by the caller.
 */
export async function deleteDocument(scope: AppScope, docId: string): Promise<void> {
  const [row] = await db
    .select({ storageKey: documents.storageKey, size: documents.size })
    .from(documents)
    .where(
      and(
        eq(documents.id, docId),
        eq(documents.orgId, scope.orgId),
        eq(documents.applicationId, scope.applicationId),
      ),
    )
    .limit(1);
  if (!row) throw notFound(`Document '${docId}' not found`);

  await db.transaction(async (tx) => {
    const deleted = await tx
      .delete(documents)
      .where(and(eq(documents.id, docId), eq(documents.orgId, scope.orgId)))
      .returning({ size: documents.size });
    if (deleted.length === 0) return; // concurrent delete won the race — no double decrement
    await tx
      .update(organizations)
      .set({
        documentsBytesUsed: sql`GREATEST(${organizations.documentsBytesUsed} - ${deleted[0]!.size}, 0)`,
      })
      .where(eq(organizations.id, scope.orgId));
  });

  await deleteStorageObject(row.storageKey);
}

/** Delete a storage object addressed by its `bucket/path` storage key. Best-effort. */
async function deleteStorageObject(storageKey: string): Promise<void> {
  const parsed = parseStorageKey(storageKey);
  if (!parsed) return;
  await storageDelete(parsed.bucket, parsed.path).catch((err) => {
    logger.warn("failed to delete document storage object", {
      storageKey,
      error: getErrorMessage(err),
    });
  });
}

// ---------------------------------------------------------------------------
// GC — expired-document sweep
// ---------------------------------------------------------------------------

/**
 * Delete documents whose retention deadline has passed (`expiresAt < now()`),
 * in batches: drop the storage objects, then delete the rows and decrement the
 * per-org counters in one transaction per batch. Mirrors `cleanupExpiredUploads`.
 * Returns the number of rows removed.
 */
export async function cleanupExpiredDocuments(): Promise<number> {
  let totalRemoved = 0;
  while (true) {
    const expired = await db
      .select({ id: documents.id, storageKey: documents.storageKey })
      .from(documents)
      .where(and(isNotNull(documents.expiresAt), lt(documents.expiresAt, new Date())))
      .limit(500);
    if (expired.length === 0) break;

    await Promise.all(expired.map((row) => deleteStorageObject(row.storageKey)));

    const ids = expired.map((r) => r.id);
    await db.transaction(async (tx) => {
      const removed = await tx
        .delete(documents)
        .where(inArray(documents.id, ids))
        .returning({ orgId: documents.orgId, size: documents.size });
      // Fold the removed bytes back per org (a batch may span orgs).
      const perOrg = new Map<string, number>();
      for (const r of removed) perOrg.set(r.orgId, (perOrg.get(r.orgId) ?? 0) + r.size);
      for (const [orgId, bytes] of perOrg) {
        await tx
          .update(organizations)
          .set({
            documentsBytesUsed: sql`GREATEST(${organizations.documentsBytesUsed} - ${bytes}, 0)`,
          })
          .where(eq(organizations.id, orgId));
      }
    });
    totalRemoved += expired.length;
    if (expired.length < 500) break;
  }
  return totalRemoved;
}

/**
 * Reconcile every org's `documents_bytes_used` counter against the authoritative
 * `SUM(documents.size)` and correct any drift. The counter is maintained
 * transactionally on each document insert/delete, but an FK **cascade** delete
 * (run / chat-session / end-user / application / org removed) drops `documents`
 * rows WITHOUT running the app-level decrement — so the counter can drift high
 * over time. This pass recomputes it from the rows and writes the corrected
 * value only for orgs where it differs (a single correlated UPDATE; floors at 0
 * for orgs whose documents all cascaded away). Returns the number of orgs fixed.
 *
 * Note: the cascade ALSO orphans the corresponding S3 objects. The storage
 * abstraction (`@appstrate/core/storage`) exposes no list/enumerate operation,
 * so an object-level orphan sweep is not implemented — those bytes are dead
 * storage, but the QUOTA a user is charged against stays exact via this counter
 * recompute. See docs/architecture/DOCUMENTS.md.
 */
export async function reconcileOrgDocumentBytes(): Promise<number> {
  const recomputed = sql<number>`COALESCE((SELECT SUM(${documents.size}) FROM ${documents} WHERE ${documents.orgId} = ${organizations.id}), 0)`;
  const fixed = await db
    .update(organizations)
    .set({ documentsBytesUsed: recomputed })
    .where(sql`${organizations.documentsBytesUsed} <> ${recomputed}`)
    .returning({ id: organizations.id });
  return fixed.length;
}

/** Aligned with the upload sweep cadence. */
const DOCUMENT_GC_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Run the counter reconciliation once every N sweep ticks (≈ daily at the 15-min
 * cadence). Low-frequency because it is a full correlated scan of `organizations`
 * — the transactional counter maintenance is the hot path; this is only the
 * drift safety net for cascade deletes.
 */
const DOCUMENT_RECONCILE_EVERY_N_TICKS = 96;

let gcTimer: ReturnType<typeof setInterval> | null = null;
let gcTicks = 0;

/**
 * Start the periodic document GC: an expired-document sweep every tick, plus a
 * low-frequency counter reconciliation pass (every N ticks). Safe to call
 * multiple times.
 */
export function startDocumentGc(): void {
  if (gcTimer) return;
  gcTimer = setInterval(() => {
    cleanupExpiredDocuments()
      .then((count) => {
        if (count > 0) logger.info("Removed expired documents", { count });
      })
      .catch((err) => {
        logger.warn("Periodic document GC failed", { error: getErrorMessage(err) });
      });
    if (gcTicks++ % DOCUMENT_RECONCILE_EVERY_N_TICKS === 0) {
      reconcileOrgDocumentBytes()
        .then((count) => {
          if (count > 0) logger.info("Reconciled org document-byte counters", { orgs: count });
        })
        .catch((err) => {
          logger.warn("Document counter reconciliation failed", { error: getErrorMessage(err) });
        });
    }
  }, DOCUMENT_GC_INTERVAL_MS);
  gcTimer.unref?.();
}

/** Stop the periodic sweep. Called from the shutdown handler. */
export function stopDocumentGc(): void {
  if (gcTimer) {
    clearInterval(gcTimer);
    gcTimer = null;
    gcTicks = 0;
  }
}

/**
 * Stream a document's bytes (for the proxy-download path). Returns null when the
 * object is missing. Split out so the content route and any future consumer
 * share one code path.
 */
export function streamDocumentContent(
  storageKey: string,
): Promise<ReadableStream<Uint8Array> | null> {
  const parsed = parseStorageKey(storageKey);
  if (!parsed) return Promise.resolve(null);
  return storageDownloadStream(parsed.bucket, parsed.path);
}
