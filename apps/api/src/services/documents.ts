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
import { actorInsert, actorScopeFilter } from "../lib/actor.ts";
import { prefixedId } from "../lib/ids.ts";
import { logger } from "../lib/logger.ts";
import { listResponse } from "../lib/list-response.ts";
import type { ListEnvelope } from "@appstrate/shared-types";
import { invalidRequest, notFound, payloadTooLarge, storageLimitExceeded } from "../lib/errors.ts";
import type { ChatAttachmentRequest, ResolvedChatAttachment } from "@appstrate/core/chat-contract";
import { consumeUploadStream, peekUploads, sanitizeFilename, parseUploadUri } from "./uploads.ts";
import { sanitizeStorageKey } from "./file-storage.ts";
import { getRun, updateRun } from "./state/runs.ts";
import { recordAudit } from "./audit.ts";

/** Durable documents bucket (distinct from the ephemeral `uploads` bucket). */
export const DOCUMENTS_BUCKET = "documents";

/** `document://doc_xxx` — the URI form stored inside run/chat input JSON. */
export const DOCUMENT_URI_PREFIX = "document://";

/**
 * Strict document id shape: `doc_` + ≥8 id chars. `prefixedId("doc")` is well
 * above this, so the bound is safely below the real minimum. Rejects malformed
 * input before it reaches the database SELECT.
 */
const DOCUMENT_ID_RE = /^doc_[A-Za-z0-9_-]{8,}$/;

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

/** Is this value a `document://doc_xxx` reference? */
export function isDocumentUri(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(DOCUMENT_URI_PREFIX);
}

/** Extract the document id from a `document://doc_xxx` URI, or null if malformed. */
export function parseDocumentUri(uri: string): string | null {
  if (!uri.startsWith(DOCUMENT_URI_PREFIX)) return null;
  const id = uri.slice(DOCUMENT_URI_PREFIX.length);
  return DOCUMENT_ID_RE.test(id) ? id : null;
}

/** The `document://` URI for a document id. */
export function documentUri(id: string): string {
  return `${DOCUMENT_URI_PREFIX}${id}`;
}

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
 * `expiresAt` a fresh document is stamped with, from `DOCUMENT_RETENTION_DAYS`.
 * Undefined ⇒ permanent (null column). Pure given `now`.
 */
export function retentionExpiry(retentionDays: number | undefined, now = new Date()): Date | null {
  if (retentionDays === undefined) return null;
  return new Date(now.getTime() + retentionDays * 24 * 60 * 60 * 1000);
}

/**
 * A pass-through TransformStream that counts bytes and computes their SHA-256
 * as they flow, without buffering. Pipe the source through `.stream` into the
 * destination sink; read `{bytes, sha256}` from `.result()` once the stream has
 * fully drained (memoized — the digest is finalized on first read, so call it
 * only after the pipe resolves). Exported so the streaming-hash contract is
 * unit-testable in isolation.
 */
export function createHashingCounter(): {
  stream: TransformStream<Uint8Array, Uint8Array>;
  result: () => { bytes: number; sha256: string };
} {
  const hasher = new Bun.CryptoHasher("sha256");
  let bytes = 0;
  let digest: string | null = null;
  const stream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
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

/** Wire shape (snake_case) for a document. */
export interface DocumentDto {
  object: "document";
  id: string;
  uri: string;
  purpose: DocumentPurpose;
  application_id: string;
  run_id: string | null;
  chat_session_id: string | null;
  package_id: string | null;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  downloadable: boolean;
  expires_at: string | null;
  created_at: string;
}

export function toDocumentDto(row: DocumentRow, actor: Actor): DocumentDto {
  return {
    object: "document",
    id: row.id,
    uri: documentUri(row.id),
    purpose: row.purpose,
    application_id: row.applicationId,
    run_id: row.runId,
    chat_session_id: row.chatSessionId,
    package_id: row.packageId,
    name: row.name,
    mime: row.mime,
    size: row.size,
    sha256: row.sha256,
    downloadable: deriveDownloadable(row, actor),
    expires_at: row.expiresAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
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

  const safeName = sanitizeStorageKey(sanitizeFilename(meta!.name));
  const storagePath = `${scope.applicationId}/${documentId}/${safeName}`;

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
    await storageDelete(DOCUMENTS_BUCKET, storagePath).catch((delErr) => {
      logger.warn("failed to delete documents object after materialize error", {
        documentId,
        error: getErrorMessage(delErr),
      });
    });
    throw err;
  }

  const { bytes: byteCount, sha256 } = digester.result();
  const expiresAt = retentionExpiry(env.DOCUMENT_RETENTION_DAYS);
  const attribution = actorInsert(actor);

  try {
    const [row] = await db.transaction(async (tx) => {
      // Lock the org row so a concurrent materialize cannot both pass the
      // quota re-check on a stale `used`. Exact byte count re-checked here.
      const [orgLocked] = await tx
        .select({ used: organizations.documentsBytesUsed })
        .from(organizations)
        .where(eq(organizations.id, scope.orgId))
        .for("update")
        .limit(1);
      if (wouldExceedOrgQuota(orgLocked?.used ?? 0, byteCount, env.ORG_STORAGE_QUOTA_BYTES)) {
        throw storageLimitExceeded(
          `Organization storage quota (${env.ORG_STORAGE_QUOTA_BYTES} bytes) would be exceeded`,
        );
      }
      const inserted = await tx
        .insert(documents)
        .values({
          id: documentId,
          orgId: scope.orgId,
          applicationId: scope.applicationId,
          purpose: "user_upload",
          runId: "runId" in container ? container.runId : null,
          chatSessionId: "chatSessionId" in container ? container.chatSessionId : null,
          packageId: opts.packageId ?? null,
          userId: attribution.userId,
          endUserId: attribution.endUserId,
          storageKey: `${DOCUMENTS_BUCKET}/${storagePath}`,
          name: meta!.name,
          mime: meta!.mime,
          size: byteCount,
          sha256,
          expiresAt,
        })
        .returning();
      await tx
        .update(organizations)
        .set({ documentsBytesUsed: sql`${organizations.documentsBytesUsed} + ${byteCount}` })
        .where(eq(organizations.id, scope.orgId));
      return inserted;
    });
    // Best-effort audit — `recordAudit` swallows its own failures. Emitted from
    // the service (not a route) because materialization runs without a request
    // context (deferred behind `createRun` in the run pipeline).
    await recordAudit({
      orgId: scope.orgId,
      applicationId: scope.applicationId,
      actorType: actor.type === "user" ? "user" : "end_user",
      actorId: actor.id,
      action: "document.created",
      resourceType: "document",
      resourceId: documentId,
      after: { name: meta!.name, size: byteCount, mime: meta!.mime, purpose: "user_upload" },
    });
    return row as DocumentRow;
  } catch (err) {
    // DB failed after the bytes landed — drop the object so its bytes are not
    // stranded uncounted in the bucket.
    await storageDelete(DOCUMENTS_BUCKET, storagePath).catch((delErr) => {
      logger.warn("failed to delete documents object after row-insert failure", {
        documentId,
        error: getErrorMessage(delErr),
      });
    });
    throw err;
  }
}

function assertWithinFileCap(size: number, cap: number): void {
  if (size > cap) {
    throw payloadTooLarge(`Document exceeds the per-file limit of ${cap} bytes`);
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
  if (wouldExceedOrgQuota(org?.used ?? 0, total, env.ORG_STORAGE_QUOTA_BYTES)) {
    throw storageLimitExceeded(
      `Organization storage quota (${env.ORG_STORAGE_QUOTA_BYTES} bytes) would be exceeded`,
    );
  }
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
    // got — a clear terminal beats a silently broken run.
    await updateRun(scope, runId, {
      status: "failed",
      error: "Failed to persist input documents",
      completedAt: new Date().toISOString(),
    }).catch((updErr) => {
      logger.warn("failed to mark run failed after materialization error", {
        runId,
        error: getErrorMessage(updErr),
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
  const data = (hasMore ? rows.slice(0, limit) : rows).map((r) =>
    toDocumentDto(r as DocumentRow, actor),
  );
  return { ...listResponse(data, { hasMore }), limit };
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/**
 * Delete a document: drop the storage object, delete the row, and decrement the
 * org counter — the counter decrement + row delete are one transaction, the
 * storage delete is best-effort (a leftover object is swept by the S3-vs-DB
 * reconciliation, and never re-counted). Authorization (owner/admin permission
 * OR creator) is enforced by the caller.
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
  const [bucket, ...rest] = storageKey.split("/");
  if (!bucket || rest.length === 0) return;
  await storageDelete(bucket, rest.join("/")).catch((err) => {
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

/** Aligned with the upload sweep cadence. */
const DOCUMENT_GC_INTERVAL_MS = 15 * 60 * 1000;

let gcTimer: ReturnType<typeof setInterval> | null = null;

/** Start the periodic expired-document sweep. Safe to call multiple times. */
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
  }, DOCUMENT_GC_INTERVAL_MS);
  gcTimer.unref?.();
}

/** Stop the periodic sweep. Called from the shutdown handler. */
export function stopDocumentGc(): void {
  if (gcTimer) {
    clearInterval(gcTimer);
    gcTimer = null;
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
  const [bucket, ...rest] = storageKey.split("/");
  if (!bucket || rest.length === 0) return Promise.resolve(null);
  return storageDownloadStream(bucket, rest.join("/"));
}
