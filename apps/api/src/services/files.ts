// SPDX-License-Identifier: Apache-2.0

/**
 * Files service — the durable, first-class file store.
 *
 * A `files` row is the source of truth for a stored object, addressed by
 * the opaque `appfile://file_xxx` URI. Two origins share the table:
 *
 *  - `user_upload` — a staged upload materialized here the first time a run (or
 *    chat session) consumes it (`createFileFromUpload`). The bytes move
 *    from the ephemeral `uploads` bucket to the durable file bucket
 *    (`files` on the wire — see {@link FILES_BUCKET}).
 *  - `agent_output` — a deliverable an agent published from a run (Phase 2).
 *
 * Access is never a per-file grant (D2): `getFileForActor` derives it from
 * the container (run read-ACL, or chat-session owner) at check time.
 * `downloadable` (whether `/content` will serve the bytes to this caller) is
 * derived, not stored: an agent output is downloadable by anyone who can read
 * the container; a user upload only by its own creator.
 *
 * Quotas (D4) are synchronous at the write: a per-file cap (413) and a per-org
 * byte quota (403 `storage_limit_exceeded`) tracked transactionally on
 * `organizations.files_bytes_used`.
 */

import {
  and,
  eq,
  gt,
  lt,
  desc,
  or,
  isNull,
  isNotNull,
  inArray,
  notInArray,
  notExists,
  exists,
  sql,
  type SQL,
} from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { files, fileLinks, organizations, chatSessions, runs } from "@appstrate/db/schema";
import type { FilePurpose } from "@appstrate/db/schema";
import {
  uploadStream as storageUploadStream,
  downloadStream as storageDownloadStream,
} from "@appstrate/db/storage";
import { fileTypeStream } from "file-type";
import { getErrorMessage } from "@appstrate/core/errors";
import { getEnv } from "@appstrate/env";
import type { Actor } from "@appstrate/connect";
import type { SpaceScope } from "../lib/scope.ts";
import { actorInsert, actorFromIds, actorScopeFilter } from "../lib/actor.ts";
import { isUniqueViolation } from "../lib/db-helpers.ts";
import { prefixedId } from "../lib/ids.ts";
import { logger } from "../lib/logger.ts";
import { listResponse } from "../lib/list-response.ts";
import type { ListEnvelope } from "@appstrate/shared-types";
import {
  conflict,
  invalidRequest,
  notFound,
  payloadTooLarge,
  storageLimitExceeded,
  fileCountExceeded,
} from "../lib/errors.ts";
import { resolveAgentOutputMime } from "./mime-policy.ts";
import type { ChatAttachmentRequest, ResolvedChatAttachment } from "@appstrate/core/chat-contract";
import { consumeUploadStream, peekUploads, parseUploadUri } from "./uploads.ts";
import { enqueueStorageDeletion, type StorageDeletionJobInput } from "./storage-deletion.ts";
import {
  recordFileCreated,
  recordFileDeleted,
  recordFileStorageLimitRejection,
} from "@appstrate/core/telemetry";
import { toStorageName } from "../lib/storage-name.ts";
import { getRun } from "./state/runs.ts";
import { synthesiseFinalize } from "./run-event-ingestion.ts";
import { recordAudit } from "./audit.ts";
import {
  signPreviewToken,
  previewKind,
  type PreviewKind,
  PREVIEW_TOKEN_TTL_SECONDS,
} from "./file-preview.ts";
import {
  FILE_ID_RE,
  isFileUri,
  parseFileUri,
  fileUri,
  extractFileIds,
} from "@appstrate/core/file-uri";

/**
 * Durable files bucket (distinct from the ephemeral `uploads` bucket).
 *
 * The VALUE and every stored `files.storage_key` must agree: a key is written
 * as `${FILES_BUCKET}/<path>` and `parseStorageKey` splits the bucket back out
 * of it at read time. The bucket was spelled `documents` until the #1177 rename
 * was finished at the physical layer; migration `0044_finish_file_rename` is
 * the data half of that move — it rewrote the `documents/` key prefix on every
 * `files` row in the same change that flipped this literal.
 *
 * Changing it again without a matching key rewrite points every download,
 * deletion and orphan sweep at a bucket that holds nothing, with no error until
 * a download 404s on a file that is physically still there.
 */
export const FILES_BUCKET = "files";

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
 * Durably enqueue the deletion of a file's storage object (by its in-bucket
 * path inside {@link FILES_BUCKET}) on a drop-on-error / drop-on-dedup path.
 *
 * These sites run when the bytes may have landed but the `files` row was
 * NEVER committed (materialize error, row-insert failure, discarded duplicate),
 * so there is no business transaction to piggyback the enqueue onto. The job is
 * the durable record: it goes into its OWN short transaction and the outbox
 * worker performs the idempotent physical delete. Never throws — a failed
 * enqueue is logged, not propagated, so it can't mask the original error the
 * caller is already unwinding.
 */
async function dropFileObject(storagePath: string, reason: string): Promise<void> {
  try {
    await db.transaction((tx) =>
      enqueueStorageDeletion(tx, {
        bucket: FILES_BUCKET,
        storageKey: storagePath,
        reason,
      }),
    );
  } catch (err) {
    logger.warn("failed to enqueue files object deletion", {
      reason,
      storagePath,
      error: getErrorMessage(err),
    });
  }
}

/**
 * Turn a stored `bucket/path` storage key into a deletion-job input (splitting
 * the bucket back off `storageKey`, which the outbox stores IN-BUCKET). Returns
 * null for a malformed key so a bad row can't stall the enqueue.
 */
export function storageKeyToDeletionJob(
  storageKey: string,
  reason: string,
): StorageDeletionJobInput | null {
  const parsed = parseStorageKey(storageKey);
  if (!parsed) return null;
  return { bucket: parsed.bucket, storageKey: parsed.path, reason };
}

/**
 * Storage path (inside {@link FILES_BUCKET}) a file's bytes live at:
 * `{spaceId}/{fileId}/{safeName}`. One builder so the layout is
 * defined once.
 */
function fileStoragePath(scope: SpaceScope, fileId: string, name: string): string {
  const safeName = toStorageName(name);
  return `${scope.spaceId}/${fileId}/${safeName}`;
}

/** The 413 message for a file exceeding the per-file cap. */
function perFileCapMessage(cap: number): string {
  return `File exceeds the per-file limit of ${cap} bytes`;
}

/** The 413 message for a run's output overrunning the per-run cap. */
function runOutputCapMessage(cap: number): string {
  return `Run output would exceed the per-run limit of ${cap} bytes`;
}

/** A Drizzle executor — either the root `db` or an open transaction handle. */
type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Fold `bytes` back off an org's `files_bytes_used` counter, clamped at 0
 * (`GREATEST`) so a drift or double-decrement can never drive it negative. The
 * single decrement primitive for every file-teardown path (single-doc
 * delete, expiry sweep, run/session detach, space/end-user cascade). Runs
 * inside the caller's transaction — each call site has already locked the org
 * row or is deleting the very rows whose bytes it folds back, so no lock is
 * taken here.
 */
export async function decrementOrgFileBytes(
  tx: DbOrTx,
  orgId: string,
  bytes: number,
): Promise<void> {
  await tx
    .update(organizations)
    .set({
      filesBytesUsed: sql`GREATEST(${organizations.filesBytesUsed} - ${bytes}, 0)`,
    })
    .where(eq(organizations.id, orgId));
}

/** Which container a materialized upload is anchored to. */
type FileContainer = { runId: string } | { chatSessionId: string };

/**
 * A staged upload that the input-parser has already rewritten to
 * `appfile://<fileId>` in the persisted run input, to be materialized into
 * a durable `files` row once the run row exists (`files.run_id` FK).
 */
export interface PendingUploadMaterialization {
  uploadId: string;
  fileId: string;
}

/** A stored file row (internal shape — carries `storageKey` for I/O). */
export interface FileRow {
  id: string;
  orgId: string;
  spaceId: string;
  purpose: FilePurpose;
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

/**
 * The full access-capability set for one file + caller — the single source
 * of truth consumed by REST, the DTO serializer, the preview mint, the MCP read
 * path, and (via the DTO) the UI. Every gate that used to be re-derived ad hoc
 * (route permission checks, `deriveDownloadable`, preview minting) now flows
 * from {@link getFileCapabilities}.
 *
 *  - `visible`  — the caller can resolve this file at all (container ACL). A
 *    non-visible file is a 404 everywhere; the other flags are then all false.
 *  - `metadata` — the caller may see the REAL name, mime and sha256. When false
 *    the DTO/MCP read serve an OPAQUE reference (generic name + mime, no sha256)
 *    — a non-creator run reader of a `user_upload` (privacy decision). `size` is
 *    intentionally NOT gated by this flag: it is exposed to opaque readers too (a
 *    byte count is not sensitive, and the gallery needs it to render every row).
 *  - `download` — the caller may fetch the bytes (`/content`).
 *  - `preview`  — the caller may render an in-browser preview (download + a
 *    previewable mime).
 *  - `keep`     — the caller may pin/clear the retention deadline.
 *  - `delete`   — the caller may delete the file.
 */
export interface FileCapabilities {
  visible: boolean;
  metadata: boolean;
  download: boolean;
  preview: boolean;
  keep: boolean;
  delete: boolean;
}

/** A file resolved for a caller, with its derived access capabilities. */
interface ResolvedFile {
  row: FileRow;
  capabilities: FileCapabilities;
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/** Generic name/mime a file degrades to when `metadata` is not granted. */
const GENERIC_FILE_NAME = "file";
const GENERIC_FILE_MIME = "application/octet-stream";

/**
 * The one access-capability computation (D2 / Anthropic rule + the locked
 * `user_upload` privacy decision). Pure — every consumer (REST route, DTO,
 * preview mint, MCP read) derives its gates from here rather than re-deriving.
 *
 *  - `agent_output` — any caller who can read the container gets full metadata +
 *    download (a deliverable is freely readable within its container, D6).
 *  - `user_upload` — content AND sensitive metadata (real name, sha256) are
 *    reserved to the CREATOR (the uploading user, or the end-user who uploaded it
 *    for end-user-scoped flows). Other legitimate run readers still SEE the row
 *    (`visible`) but get an opaque reference (`metadata: false`, `download:
 *    false`) — never the bytes, the real name, or the hash (kills the
 *    cross-member disclosure + CDN-abuse vectors).
 *  - `keep` / `delete` — the file's creator OR a caller holding
 *    `files:delete` (owner/admin). The management permission does NOT grant
 *    metadata or download of another member's upload — only lifecycle control.
 *
 * `opts.visible` is the container-ACL outcome (resolved by
 * {@link getFileForActor} / the list SQL / a valid preview token); when
 * false every capability collapses to false.
 */
export function getFileCapabilities(
  doc: { purpose: FilePurpose; userId: string | null; endUserId: string | null; mime: string },
  actor: Actor,
  opts: { visible: boolean; canManage?: boolean },
): FileCapabilities {
  if (!opts.visible) {
    return {
      visible: false,
      metadata: false,
      download: false,
      preview: false,
      keep: false,
      delete: false,
    };
  }
  const isAgentOutput = doc.purpose === "agent_output";
  const isCreator = actor.type === "user" ? doc.userId === actor.id : doc.endUserId === actor.id;
  // agent_output → any container reader; user_upload → creator/uploader only.
  const download = isAgentOutput || isCreator;
  // Sensitive metadata (real name / mime / sha256) follows the same boundary as
  // the content (never widen a private upload's real name / hash to a non-creator
  // reader). `size` is deliberately NOT covered by this flag — a byte count is
  // not sensitive and stays visible to opaque readers.
  const metadata = isAgentOutput || isCreator;
  const preview = download && previewKind(doc.mime) !== null;
  // Lifecycle control: creator OR the org's manage permission.
  const manage = isCreator || (opts.canManage ?? false);
  return { visible: true, metadata, download, preview, keep: manage, delete: manage };
}

/**
 * The name/mime/sha256 a caller is allowed to see, degrading to a generic,
 * hash-less reference when `metadata` is not granted. One place so the DTO and
 * the MCP read path degrade identically.
 */
export function projectFileMetadata(
  row: Pick<FileRow, "name" | "mime" | "sha256">,
  capabilities: Pick<FileCapabilities, "metadata">,
): { name: string; mime: string; sha256?: string } {
  if (capabilities.metadata) return { name: row.name, mime: row.mime, sha256: row.sha256 };
  return { name: GENERIC_FILE_NAME, mime: GENERIC_FILE_MIME };
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
 * Resolve the effective per-org storage limit (in bytes) from the org's own
 * override and the global env quota:
 *
 *   organization.files_bytes_limit ?? env.ORG_STORAGE_QUOTA_BYTES ?? unlimited
 *
 * `undefined` return = no limit (unlimited) — the exact shape
 * {@link wouldExceedOrgQuota} treats as "no ceiling". A per-org override of `0`
 * is honored (a hard zero limit, not "unset"); NULL/undefined `orgLimit` falls
 * back to the env quota. Pure — the single resolution point every enforcement
 * site (pre-flight fast reject + FOR UPDATE re-check) reads through.
 */
export function effectiveOrgStorageLimit(
  orgLimit: number | null | undefined,
  envQuota: number | undefined,
): number | undefined {
  if (orgLimit !== null && orgLimit !== undefined) return orgLimit;
  return envQuota;
}

/**
 * Throw the 403 `storage_limit_exceeded` when writing `addBytes` on top of
 * `used` would overrun the org's effective storage limit (resolved override or
 * env quota — see {@link effectiveOrgStorageLimit}). The org-limit rejection in
 * one place (pre-flight fast reject + FOR UPDATE re-check). `limit` undefined =
 * unlimited (no-op).
 */
function assertWithinOrgQuota(used: number, addBytes: number, limit: number | undefined): void {
  if (wouldExceedOrgQuota(used, addBytes, limit)) {
    // One quota rejection per logical over-limit write. This is the single
    // assert seam — the pre-flight fast reject and the FOR UPDATE re-check both
    // route through it, and only one of them ever fires for a given write.
    recordFileStorageLimitRejection();
    throw storageLimitExceeded(`Organization storage limit (${limit} bytes) would be exceeded`);
  }
}

/**
 * Set (or clear) an organization's per-org file storage limit — the narrow
 * capability the out-of-repo cloud module pilots per org via
 * `PlatformServices.setFileStorageLimit`. Billing-neutral: a technical byte
 * ceiling, never a plan or price.
 *
 *  - `bytes` a non-negative safe integer → the org's override (takes precedence
 *    over `ORG_STORAGE_QUOTA_BYTES`).
 *  - `bytes` null → clears the override (the org falls back to the env quota).
 *
 * Throws {@link invalidRequest} for a non-integer / negative / unsafe `bytes`,
 * and {@link notFound} when `orgId` does not exist — the RFC 9457 shapes the
 * rest of the service throws, consistent with the module contract.
 */
export async function setOrgFileStorageLimit(orgId: string, bytes: number | null): Promise<void> {
  if (bytes !== null && (!Number.isSafeInteger(bytes) || bytes < 0)) {
    throw invalidRequest("File storage limit must be a non-negative integer or null");
  }
  const updated = await db
    .update(organizations)
    .set({ filesBytesLimit: bytes })
    .where(eq(organizations.id, orgId))
    .returning({ id: organizations.id });
  if (updated.length === 0) throw notFound(`Organization '${orgId}' not found`);
}

/**
 * `expiresAt` a fresh file is stamped with, from `FILE_RETENTION_DAYS`.
 * Undefined ⇒ permanent (null column). Pure given `now`.
 */
export function retentionExpiry(retentionDays: number | undefined, now = new Date()): Date | null {
  if (retentionDays === undefined) return null;
  return new Date(now.getTime() + retentionDays * 24 * 60 * 60 * 1000);
}

/** Mid-stream byte ceiling for {@link createHashingCounter}. */
interface HashingCounterCaps {
  perFileCap: number;
}

/**
 * A pass-through TransformStream that counts bytes and computes their SHA-256
 * as they flow, without buffering. Pipe the source through `.stream` into the
 * destination sink; read `{bytes, sha256}` from `.result()` once the stream has
 * fully drained (memoized — the digest is finalized on first read, so call it
 * only after the pipe resolves). Exported so the streaming-hash contract is
 * unit-testable in isolation.
 *
 * When `caps` is supplied, the stream also enforces the per-file byte ceiling
 * mid-stream: as soon as it is exceeded the stream errors (aborting the S3 write
 * so no full object lands), with a {@link payloadTooLarge} message so the caller
 * surfaces a 413. The per-RUN output cap is deliberately NOT enforced here — it
 * is checked authoritatively at commit time ({@link commitFileRow}) only, so
 * that a retried publish of an already-committed file can still reach dedup and
 * return an idempotent 200 instead of tripping a mid-stream 413. Used by the
 * agent-output ingestion path, which has no declared size to pre-check. Without
 * `caps` it just counts + hashes.
 */
export function createHashingCounter(caps?: HashingCounterCaps): {
  stream: TransformStream<Uint8Array, Uint8Array>;
  result: () => { bytes: number; sha256: string };
} {
  const hasher = new Bun.CryptoHasher("sha256");
  let bytes = 0;
  let digest: string | null = null;
  const stream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (caps && bytes > caps.perFileCap) {
        controller.error(payloadTooLarge(perFileCapMessage(caps.perFileCap)));
        return;
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
 * Wire shape for a file. Field casing follows CASING_CONVENTIONS.md
 * carve-out 4b (universal DB-convention fields stay camelCase EVERYWHERE):
 * `spaceId`, `packageId`, `createdAt`, `expiresAt` are on that exact list.
 * `run_id` / `chat_session_id` are NOT on it (the list carves out `scheduleId`,
 * `apiKeyId`, `endUserId` but deliberately not `runId`), so they stay snake_case
 * as domain fields — matching the `notification` DTO's `run_id` and the `Run`
 * DTO's treatment of non-listed `*_id` fields.
 */
interface FileDto {
  object: "file";
  id: string;
  uri: string;
  purpose: FilePurpose;
  spaceId: string;
  run_id: string | null;
  chat_session_id: string | null;
  packageId: string | null;
  /**
   * Display name. Degrades to the generic {@link GENERIC_FILE_NAME} when the
   * caller lacks the `metadata` capability (a non-creator run reader of a
   * `user_upload`) — the real filename is never disclosed to them.
   */
  name: string;
  /**
   * MIME type. Degrades to {@link GENERIC_FILE_MIME} when the caller lacks
   * the `metadata` capability.
   */
  mime: string;
  size: number;
  /**
   * SHA-256 of the bytes (hex) — OMITTED (absent) when the caller lacks the
   * `metadata` capability, so a private upload's content hash is never disclosed
   * to a non-creator reader.
   */
  sha256?: string;
  downloadable: boolean;
  /**
   * The full access-capability set for this caller ({@link FileCapabilities}).
   * The single source the UI drives download/preview/keep/delete affordances
   * from; `downloadable` / `previewable` are kept as flat mirrors of
   * `capabilities.download` / `capabilities.preview` for existing consumers.
   */
  capabilities: FileCapabilities;
  /**
   * Whether this file has an in-browser preview the caller may open — a
   * previewable mime ({@link PreviewKind}) on a file the caller can read. A
   * cheap boolean carried on EVERY row (list + single GET) so the gallery can
   * show the preview affordance without minting a signed token per row (the
   * token is minted only on the single-file GET, below).
   */
  previewable: boolean;
  /**
   * How this file previews — `html` | `image` | `pdf` | `text`, or null when
   * not previewable. Carried on EVERY row so the frontend knows which render
   * path (sandboxed iframe / `<img>` / native-PDF iframe / plaintext `<pre>`) to
   * use without inspecting the mime itself. snake_case: not on the universal
   * DB-convention carve-out list.
   */
  preview_kind: PreviewKind | null;
  /**
   * Absolute URL of a hardened, cookie-less HTML preview — minted ONLY on the
   * single-file GET (never in list rows, to avoid signing a short-lived
   * token per gallery row). Non-null only for a previewable file. Carries a
   * short-lived signed token (`?t=`); the SPA loads it in an
   * `sandbox="allow-scripts"` iframe — the ONLY context in which an `html`
   * file is served as active content (any other load, a top-level
   * navigation above all, gets inert `text/plain` source, in every mode). On
   * the `USERCONTENT_URL` origin when set, else on `APP_URL`. Absent
   * (undefined) on list rows.
   */
  preview_url?: string | null;
  expiresAt: string | null;
  createdAt: string;
}

/**
 * Mint the hardened-preview URL for a resolved file, or null when its mime
 * is not previewable ({@link previewKind}). The token authorizes a GET of THIS
 * file's preview for {@link PREVIEW_TOKEN_TTL_SECONDS}; the URL points at the
 * cookie-less preview route on `USERCONTENT_URL` (separate registrable domain —
 * strongest isolation) when configured, else same-origin on `APP_URL`. Called
 * only after the container ACL already resolved the row for the caller, so
 * presence of a URL is itself the "previewable by you" signal.
 */
function mintPreviewUrl(row: FileRow, actor: Actor): string | null {
  if (previewKind(row.mime) === null) return null;
  const env = getEnv();
  const exp = Math.floor(Date.now() / 1000) + PREVIEW_TOKEN_TTL_SECONDS;
  // Bind the minting actor into the token (defense-in-depth for S1): the
  // preview route re-checks it against the file's creator for a
  // `user_upload`, so a hand-crafted token for another member's private
  // upload is refused even if it verifies.
  const creator = actorInsert(actor);
  const token = signPreviewToken(
    { d: row.id, o: row.orgId, e: exp, u: creator.userId, eu: creator.endUserId },
    env.UPLOAD_SIGNING_SECRET,
  );
  let base = env.USERCONTENT_URL ?? env.APP_URL;
  while (base.endsWith("/")) base = base.slice(0, -1);
  return `${base}/preview/files/${row.id}?t=${encodeURIComponent(token)}`;
}

/**
 * Serialize a resolved file row to its wire DTO from its precomputed
 * {@link FileCapabilities} (the single source — {@link getFileCapabilities}).
 * The DTO applies the metadata degradation ({@link projectFileMetadata}):
 * when `capabilities.metadata` is false the row serves a generic name, a generic
 * mime, and OMITS `sha256` — so a non-creator run reader of a `user_upload` never
 * learns its real name or content hash.
 *
 * `mintPreview` mints the signed `preview_url` — set ONLY on the single-file
 * GET, never in list rows (a list of N rows must not sign N short-lived tokens).
 * `previewable` / `downloadable` are flat mirrors of the capability booleans so
 * existing consumers keep working while the UI drives affordances off
 * `capabilities`.
 */
export function toFileDto(
  row: FileRow,
  actor: Actor,
  capabilities: FileCapabilities,
  opts: { mintPreview?: boolean } = {},
): FileDto {
  const view = projectFileMetadata(row, capabilities);
  const previewable = capabilities.preview;
  return {
    object: "file",
    id: row.id,
    uri: fileUri(row.id),
    purpose: row.purpose,
    spaceId: row.spaceId,
    run_id: row.runId,
    chat_session_id: row.chatSessionId,
    packageId: row.packageId,
    name: view.name,
    mime: view.mime,
    size: row.size,
    ...(view.sha256 !== undefined ? { sha256: view.sha256 } : {}),
    downloadable: capabilities.download,
    capabilities,
    previewable,
    // `previewKind` is computed from the REAL mime — when metadata is degraded
    // preview is already false (a non-creator upload is never downloadable), so
    // this stays consistent with the generic mime on the wire.
    preview_kind: previewable ? previewKind(row.mime) : null,
    ...(opts.mintPreview ? { preview_url: previewable ? mintPreviewUrl(row, actor) : null } : {}),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Create (materialize a staged upload into a durable file)
// ---------------------------------------------------------------------------

/**
 * Materialize a staged upload into a durable file: stream the upload bucket
 * → files bucket (computing sha256 on the fly), then insert the row and
 * increment the org's byte counter in one transaction.
 *
 * Reuses {@link consumeUploadStream} for the byte-count + magic-byte MIME
 * validation (no duplication of that logic here); the sink pipes the bytes into
 * the files bucket and hashes them. The S3 write completes BEFORE the DB
 * commit — so on any DB failure the just-written object is deleted (mirrors the
 * first-consume rollback in `uploads.ts`), never leaving an orphan whose bytes
 * were counted against no row.
 *
 * Quotas are synchronous: the per-file cap and org quota are checked on the
 * declared size before streaming (fast reject), then re-checked on the exact
 * byte count inside the transaction with the org row locked `FOR UPDATE`.
 */
export async function createFileFromUpload(
  scope: SpaceScope,
  actor: Actor,
  uploadId: string,
  container: FileContainer,
  opts: { fileId?: string; packageId?: string | null } = {},
): Promise<FileRow> {
  const env = getEnv();
  const fileId = opts.fileId ?? prefixedId("file");

  // Access context: the acting principal is threaded into peek/consume so a
  // member can only materialize their OWN staged upload (ownership gate).
  const access = { ...scope, actor };

  // Declared-size pre-check: reject an over-cap / over-quota upload before
  // streaming a single byte. `peekUploads` also validates tenant + ownership +
  // expiry (same not-found / gone shapes as consume).
  const [meta] = (await peekUploads([uploadId], access)).values();
  await assertWithinFileLimits(scope.orgId, [meta!.size]);

  const storagePath = fileStoragePath(scope, fileId, meta!.name);

  // Stream upload → files bucket, hashing + counting on the fly. The sink's
  // returned `{bytes, sniffedMime, sha256}` feed consume's size + MIME + client
  // integrity validation (a client-declared upload sha256 is compared against
  // the streamed hash and rejected on mismatch — covers the S3-proxy path).
  const digester = createHashingCounter();
  try {
    await consumeUploadStream(uploadId, access, async (src) => {
      const detection = await fileTypeStream(src);
      await storageUploadStream(FILES_BUCKET, storagePath, detection.pipeThrough(digester.stream), {
        exclusive: true,
      });
      const { bytes, sha256 } = digester.result();
      return { bytes, sniffedMime: detection.fileType?.mime, sha256 };
    });
  } catch (err) {
    // The doc object may have been (partially) written before the throw
    // (size/MIME mismatch is validated post-drain). Drop it so the counter and
    // storage never disagree; consume already rolled back the upload side.
    await dropFileObject(storagePath, "materialize_error");
    throw err;
  }

  const { bytes: byteCount, sha256 } = digester.result();

  const committed = await commitFileRow({
    scope,
    fileId,
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
    expiresAt: retentionExpiry(env.FILE_RETENTION_DAYS),
  });
  return committed.row;
}

/** Transactional outcome of committing a just-streamed file object. */
interface CommittedFileRow {
  row: FileRow;
  deduped: boolean;
}

/**
 * Commit a just-streamed file object into a durable `files` row: the
 * FOR UPDATE org-quota re-check + row insert + byte-counter increment run in
 * one transaction, and on any failure the storage object is dropped so its
 * bytes are never stranded uncounted in the bucket. Shared by
 * {@link createFileFromUpload} (staged-upload materialization) and
 * {@link createFileFromStream} (agent-output ingestion) so the quota
 * transaction + audit live in exactly one place.
 */
async function commitFileRow(params: {
  scope: SpaceScope;
  fileId: string;
  /** Path inside {@link FILES_BUCKET} the bytes were streamed to. */
  storagePath: string;
  purpose: FilePurpose;
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
   * Per-run output ceiling ({@link createFileFromStream} only). When set,
   * the run's `agent_output` total is re-summed under the same org `FOR UPDATE`
   * lock and this file is rejected (413) if it would overrun the cap. This is
   * the sole per-run cap enforcement point (the stream no longer pre-checks or
   * enforces it mid-stream), and the lock serialises concurrent publishes so
   * each observes the other's committed bytes rather than a stale total.
   */
  runOutputCap?: number;
  /**
   * Per-run output COUNT ceiling ({@link createFileFromStream} only). When
   * set, the number of `agent_output` files already published by this run is
   * re-counted under the SAME org `FOR UPDATE` lock and this publish is rejected
   * (413 `file_count_exceeded`) if it would exceed the cap. Bounds the file
   * COUNT the byte cap does not (thousands of tiny files). Placed here (not
   * mid-stream) so a retried publish of an already-committed file reaches dedup
   * first — same rationale as the byte cap.
   */
  runMaxFiles?: number;
}): Promise<CommittedFileRow> {
  const { scope, fileId, storagePath, byteCount, attribution } = params;
  try {
    const committed = await db.transaction(async (tx): Promise<CommittedFileRow> => {
      // Lock the org row so a concurrent write cannot both pass the quota
      // re-check on a stale `used`. Exact byte count re-checked here against the
      // org's effective limit (per-org override ?? env quota).
      const [orgLocked] = await tx
        .select({
          used: organizations.filesBytesUsed,
          limit: organizations.filesBytesLimit,
        })
        .from(organizations)
        .where(eq(organizations.id, scope.orgId))
        .for("update")
        .limit(1);

      // Re-check dedup AFTER acquiring the serialization lock and BEFORE every
      // quota/cap gate. Two identical concurrent publishes can both miss the
      // optimistic pre-commit lookup; the loser must still resolve to the
      // winner even when that winner has just filled the run/org quota.
      if (params.runId && params.purpose === "agent_output") {
        const existing = await findDedupFile(tx, scope, params.runId, params.sha256, params.name);
        if (existing) {
          return { row: existing, deduped: true };
        }
      }

      assertWithinOrgQuota(
        orgLocked?.used ?? 0,
        byteCount,
        effectiveOrgStorageLimit(orgLocked?.limit, getEnv().ORG_STORAGE_QUOTA_BYTES),
      );
      // Per-run cap re-check under the same lock (agent-output ingestion). The
      // org `FOR UPDATE` above serialises every commit for this org — so two
      // concurrent publishes to the same run each observe the other's already-
      // committed row here, and their combined total is bounded exactly.
      if (params.runId && params.purpose === "agent_output") {
        if (params.runOutputCap !== undefined) {
          const runTotal = await runOutputBytesUsed(tx, scope, params.runId);
          if (runTotal + byteCount > params.runOutputCap) {
            throw payloadTooLarge(runOutputCapMessage(params.runOutputCap));
          }
        }
        // Per-run COUNT cap — re-counted under the same lock so concurrent
        // publishes each observe the other's committed row and the combined
        // count is bounded exactly. `count >= cap` means this (cap+1)-th publish
        // must fail.
        if (params.runMaxFiles !== undefined) {
          const runCount = await runOutputCountUsed(tx, scope, params.runId);
          if (runCount >= params.runMaxFiles) {
            throw fileCountExceeded(
              `Run output would exceed the per-run limit of ${params.runMaxFiles} files`,
            );
          }
        }
      }
      const inserted = await tx
        .insert(files)
        .values({
          id: fileId,
          orgId: scope.orgId,
          spaceId: scope.spaceId,
          purpose: params.purpose,
          runId: params.runId,
          chatSessionId: params.chatSessionId,
          packageId: params.packageId,
          userId: attribution.userId,
          endUserId: attribution.endUserId,
          storageKey: `${FILES_BUCKET}/${storagePath}`,
          name: params.name,
          mime: params.mime,
          size: byteCount,
          sha256: params.sha256,
          expiresAt: params.expiresAt,
        })
        .returning();
      await tx
        .update(organizations)
        .set({ filesBytesUsed: sql`${organizations.filesBytesUsed} + ${byteCount}` })
        .where(eq(organizations.id, scope.orgId));
      return { row: inserted[0] as FileRow, deduped: false };
    });
    if (committed.deduped) {
      await dropFileObject(storagePath, "dedup_duplicate");
      return committed;
    }
    // Best-effort audit — `recordAudit` swallows its own failures. Emitted from
    // the service (not a route) because these writes run without a request
    // context (materialization behind `createRun`; agent-output ingestion is
    // HMAC-run-authenticated, not a user session).
    const auditActor = actorFromIds(attribution.userId, attribution.endUserId);
    await recordAudit({
      orgId: scope.orgId,
      spaceId: scope.spaceId,
      actorType: auditActor ? auditActor.type : "system",
      actorId: auditActor?.id ?? null,
      action: "file.created",
      resourceType: "file",
      resourceId: fileId,
      after: { name: params.name, size: byteCount, mime: params.mime, purpose: params.purpose },
    });
    // One durable file committed (the sole commit seam — an agent-output
    // dedup replay never reaches here, so it is correctly not counted).
    recordFileCreated({ purpose: params.purpose });
    return committed;
  } catch (err) {
    // DB failed after the bytes landed — drop the object so its bytes are not
    // stranded uncounted in the bucket.
    await dropFileObject(storagePath, "row_insert_failure");
    throw err;
  }
}

/**
 * Sum the bytes of the `agent_output` files a run has already published —
 * the running total the per-run output cap ({@link createFileFromStream})
 * checks the incoming file against.
 */
async function runOutputBytesUsed(
  executor: DbOrTx,
  scope: SpaceScope,
  runId: string,
): Promise<number> {
  const [row] = await executor
    .select({ total: sql<string>`COALESCE(SUM(${files.size}), 0)` })
    .from(files)
    .where(
      and(eq(files.runId, runId), eq(files.orgId, scope.orgId), eq(files.purpose, "agent_output")),
    );
  return Number(row?.total ?? 0);
}

/**
 * Count the `agent_output` files a run has already published — the running
 * count the per-run file-count cap ({@link createFileFromStream}) checks
 * the incoming file against.
 */
async function runOutputCountUsed(
  executor: DbOrTx,
  scope: SpaceScope,
  runId: string,
): Promise<number> {
  const [row] = await executor
    .select({ count: sql<string>`COUNT(*)` })
    .from(files)
    .where(
      and(eq(files.runId, runId), eq(files.orgId, scope.orgId), eq(files.purpose, "agent_output")),
    );
  return Number(row?.count ?? 0);
}

/** The outcome of an agent-output ingestion: the row plus whether it deduped. */
interface CreatedFileFromStream {
  row: FileRow;
  /** True when an identical (run, sha256, name) file already existed. */
  deduped: boolean;
}

/**
 * The existing `agent_output` file a re-published (run, sha256, name) tuple
 * dedups against — the same key the partial unique index enforces. Used both as
 * the fast-path pre-commit check and to recover the winner's row after losing a
 * concurrent-insert race.
 */
async function findDedupFile(
  executor: DbOrTx,
  scope: SpaceScope,
  runId: string,
  sha256: string,
  name: string,
): Promise<FileRow | null> {
  const [existing] = await executor
    .select(fileSelect)
    .from(files)
    .where(
      and(
        eq(files.runId, runId),
        eq(files.orgId, scope.orgId),
        eq(files.spaceId, scope.spaceId),
        eq(files.purpose, "agent_output"),
        eq(files.sha256, sha256),
        eq(files.name, name),
      ),
    )
    .limit(1);
  return (existing as FileRow) ?? null;
}

/**
 * Ingest an agent-published file from a run's streaming request body into a
 * durable `agent_output` file. Mirrors {@link createFileFromUpload} but
 * for the run→platform channel: the bytes arrive as a raw stream (no staged
 * upload), so the per-file cap is enforced mid-stream via
 * {@link createHashingCounter}'s `caps` (413) while the org quota, the per-run
 * output cap, and the counter are all committed transactionally via the shared
 * {@link commitFileRow}. The per-run cap is enforced at commit time ONLY —
 * a genuinely-new over-budget file therefore streams fully (bounded by the
 * per-file cap) before its 413, a deliberate trade-off so a retried publish of
 * an already-committed file reaches the dedup path below and returns an
 * idempotent 200 rather than tripping a premature mid-stream run-cap 413.
 *
 * Idempotent for the sweep's at-least-once retries: if this run already
 * published a file with the SAME sha256 AND name, the just-streamed object
 * is dropped and the existing row returned (`deduped: true`) rather than storing
 * the bytes twice. Two layers enforce this: a fast-path pre-commit SELECT, and —
 * for the concurrent-publish race where both callers pass that SELECT — the
 * partial unique index `(run_id, sha256, name) WHERE purpose = 'agent_output'`,
 * whose violation the commit path catches and resolves to the same dedup (200).
 */
export async function createFileFromStream(
  scope: SpaceScope,
  runId: string,
  attribution: { userId: string | null; endUserId: string | null },
  packageId: string | null,
  input: {
    name: string;
    mime: string;
    body: ReadableStream<Uint8Array>;
  },
): Promise<CreatedFileFromStream> {
  const env = getEnv();
  const fileId = prefixedId("file");
  const storagePath = fileStoragePath(scope, fileId, input.name);

  const digester = createHashingCounter({
    perFileCap: env.FILE_MAX_BYTES,
  });

  // Sniff the magic bytes as the stream flows so the STORED mime can be made
  // honest. Unlike user uploads (which REJECT a declared/sniffed mismatch), an
  // agent output is never rejected — an agent legitimately emits an odd file
  // under a mime it never considered — so a concrete sniffed type that does not
  // match the declared one RELABELS the stored mime ({@link resolveAgentOutputMime}).
  // This keeps the downstream preview/kind logic safe without failing publishes.
  let sniffedMime: string | undefined;
  try {
    const detection = await fileTypeStream(input.body);
    await storageUploadStream(FILES_BUCKET, storagePath, detection.pipeThrough(digester.stream), {
      exclusive: true,
    });
    sniffedMime = detection.fileType?.mime;
  } catch (err) {
    // Cap tripped mid-stream (or a transient storage error) — the object may
    // have been partially written before the abort. Drop it so a cut-short
    // upload never leaves a partial object behind (the 413 delete-on-short
    // contract) nor strands bytes uncounted.
    await dropFileObject(storagePath, "stream_error");
    throw err;
  }

  const { bytes: byteCount, sha256 } = digester.result();
  const storedMime = resolveAgentOutputMime(input.mime, sniffedMime);

  // Dedup fast path: an identical (run, sha256, name) agent_output already
  // exists — the sweep re-published a file the tool already stored, or a retried
  // POST. Drop the freshly-written object and return the existing row.
  const existing = await findDedupFile(db, scope, runId, sha256, input.name);
  if (existing) {
    await dropFileObject(storagePath, "dedup_duplicate");
    return { row: existing, deduped: true };
  }

  try {
    const committed = await commitFileRow({
      scope,
      fileId,
      storagePath,
      purpose: "agent_output",
      runId,
      chatSessionId: null,
      packageId,
      attribution,
      name: input.name,
      // Store the sniff-relabelled mime (honest labeling for agent outputs).
      mime: storedMime,
      byteCount,
      sha256,
      expiresAt: retentionExpiry(env.FILE_RETENTION_DAYS),
      // Authoritative (and only) per-run cap checks — re-summed/re-counted under
      // the org `FOR UPDATE` lock inside commitFileRow. Enforced here, not
      // mid-stream, so a retried publish of an already-committed file reaches
      // dedup first.
      runOutputCap: env.RUN_MAX_OUTPUT_BYTES,
      runMaxFiles: env.RUN_MAX_FILES,
    });
    return committed;
  } catch (err) {
    // Lost the concurrent-insert race: another publish committed the same
    // (run, sha256, name) between our SELECT and INSERT, so the partial unique
    // index rejected ours. commitFileRow already dropped OUR object; recover
    // the winner's row and return it as the dedup case (never double-counts).
    if (isUniqueViolation(err)) {
      const winner = await findDedupFile(db, scope, runId, sha256, input.name);
      if (winner) {
        return { row: winner, deduped: true };
      }
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
 * Synchronous file-quota gate on DECLARED sizes — the per-file cap (413)
 * per size and the org byte quota (403) against the running
 * `files_bytes_used`. Shared by `createFileFromUpload` (single size,
 * before it streams) and the input-parser pre-flight (the run's whole upload
 * set, before the run launches), so the quota math lives in one place. The
 * authoritative exact-byte re-check stays inside `createFileFromUpload`'s
 * `FOR UPDATE` transaction — this is the fast, pre-write reject.
 */
export async function assertWithinFileLimits(orgId: string, sizes: number[]): Promise<void> {
  const env = getEnv();
  for (const size of sizes) assertWithinFileCap(size, env.FILE_MAX_BYTES);
  if (sizes.length === 0) return;
  const total = sizes.reduce((sum, s) => sum + s, 0);
  const [org] = await db
    .select({ used: organizations.filesBytesUsed, limit: organizations.filesBytesLimit })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  // Resolve the effective limit (per-org override ?? env quota). Undefined =
  // unlimited, so the org-limit assert is a no-op — the fast reject stays free
  // for orgs with no override and no env quota.
  const limit = effectiveOrgStorageLimit(org?.limit, env.ORG_STORAGE_QUOTA_BYTES);
  assertWithinOrgQuota(org?.used ?? 0, total, limit);
}

/**
 * Materialize the uploads the input-parser deferred, now that the run row
 * exists. Runs after `createRun` inside `prepareAndExecuteRun`. Each is anchored
 * to the run with the pre-minted file id the persisted input already
 * references (`appfile://<fileId>`).
 *
 * The common rejections (over-quota, over-cap) are pre-flighted in the
 * input-parser before `createRun`, so a failure here is a rare I/O error. It
 * must NOT be swallowed: the persisted run input references these file ids,
 * so a half-materialized run is a broken state. On any error we roll back the
 * files already created for this run, mark the run failed with a clear
 * reason, and rethrow so the route surfaces the real error to the caller.
 */
export async function materializeRunUploads(
  scope: SpaceScope,
  actor: Actor,
  runId: string,
  packageId: string | null,
  pending: PendingUploadMaterialization[],
): Promise<void> {
  const created: string[] = [];
  try {
    for (const { uploadId, fileId } of pending) {
      await createFileFromUpload(scope, actor, uploadId, { runId }, { fileId, packageId });
      created.push(fileId);
    }
  } catch (err) {
    // Roll back the partial batch so no file row the persisted input
    // references is left half-created (or its bytes counted against the org).
    for (const fileId of created) {
      await deleteFile(scope, fileId).catch((cleanupErr) => {
        logger.warn("failed to roll back materialized file after run failure", {
          runId,
          fileId,
          error: getErrorMessage(cleanupErr),
        });
      });
    }
    // Fail the run loudly rather than leaving it pointing at files it never
    // got — a clear terminal beats a silently broken run. Route through the
    // canonical convergence point (`synthesiseFinalize` → `finalizeRun`) so the
    // terminal broadcast fires like any other terminal transition, instead
    // of writing `runs.status` directly. The run has not launched its container
    // yet (createRun already stamped the sink secret), so this is a clean failed
    // finalize.
    await synthesiseFinalize(runId, {
      status: "failed",
      error: { message: "Failed to persist input files" },
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

const fileSelect = {
  id: files.id,
  orgId: files.orgId,
  spaceId: files.spaceId,
  purpose: files.purpose,
  runId: files.runId,
  chatSessionId: files.chatSessionId,
  packageId: files.packageId,
  userId: files.userId,
  endUserId: files.endUserId,
  storageKey: files.storageKey,
  name: files.name,
  mime: files.mime,
  size: files.size,
  sha256: files.sha256,
  expiresAt: files.expiresAt,
  createdAt: files.createdAt,
} as const;

/**
 * Resolve a file for `actor`, enforcing the container's read-ACL (D2).
 * Returns `null` (→ 404 at the route) when the file does not exist in the
 * caller's org+space, or when the container's ACL rejects the actor — a
 * cross-org, cross-space, or cross-actor id is indistinguishable from a missing
 * one. The full {@link FileCapabilities} are derived once here (the single
 * source) — `permissions` supplies the `files:delete` grant that decides the
 * `keep` / `delete` capabilities (default: none).
 */
export async function getFileForActor(
  scope: SpaceScope,
  actor: Actor,
  fileId: string,
  permissions: ReadonlySet<string> = new Set(),
): Promise<ResolvedFile | null> {
  if (!FILE_ID_RE.test(fileId)) return null;
  const [row] = await db
    .select(fileSelect)
    .from(files)
    .where(
      and(eq(files.id, fileId), eq(files.orgId, scope.orgId), eq(files.spaceId, scope.spaceId)),
    )
    .limit(1);
  if (!row) return null;

  if (row.runId) {
    // Run container: reuse the run's read semantics (org+space scope already
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
  } else {
    // Detached (both containers NULL — the legal state under
    // `chk_files_single_container`): no container to inherit an ACL from.
    // Org+space already matched above; apply the same end-user guard the run
    // container would (an end_user reads only its own rows).
    if (actor.type === "end_user" && row.endUserId !== actor.id) return null;
    // Conservative invariant: a detached `user_upload` is creator-only, fully
    // (metadata included) — never widened by deletion. The `download` capability
    // IS the creator check for a `user_upload` (true only for its creator), so a
    // non-creator resolves it to null. A detached `agent_output` stays
    // org-readable (its `download` is always true). This intentionally also
    // narrows a run-origin detached upload to creator-only — least surprise.
    if (
      row.purpose === "user_upload" &&
      !getFileCapabilities(row, actor, { visible: true }).download
    ) {
      return null;
    }
  }

  const capabilities = getFileCapabilities(row, actor, {
    visible: true,
    canManage: permissions.has("files:delete"),
  });
  return { row: row as FileRow, capabilities };
}

/**
 * Load a file row by id, scoped to `orgId` only — for the cookie-less
 * preview route, whose signed token IS the authorization (no session actor, no
 * container ACL re-check: the token was minted by `getFileForActor` having
 * already resolved the row for a caller). Binding to the token's `orgId` means a
 * token whose tenant does not match the stored row resolves to null (→ 404).
 * Returns null for a malformed id or a miss.
 */
export async function loadFileForPreview(orgId: string, fileId: string): Promise<FileRow | null> {
  if (!FILE_ID_RE.test(fileId)) return null;
  const [row] = await db
    .select(fileSelect)
    .from(files)
    .where(and(eq(files.id, fileId), eq(files.orgId, orgId)))
    .limit(1);
  return (row as FileRow) ?? null;
}

/**
 * Resolve a chat composer file attachment to a durable `appfile://` URI + its
 * metadata (the seam behind `PlatformServices.resolveChatAttachment`, wired for
 * the chat module which has no DB access):
 *
 *  - `upload://upl_x` → materialize it into a chat-session-scoped file
 *    (purpose `user_upload`, attributed to the session owner) and return the new
 *    `appfile://` URI. Quota/cap rejections propagate as RFC 9457 errors.
 *  - `appfile://file_x` → validate the session owner can read it (container ACL)
 *    and echo it back; a foreign/missing file is a 404.
 *
 * Chat sessions are per dashboard user, so the actor is always a `user`.
 */
export async function resolveChatAttachment(
  request: ChatAttachmentRequest,
): Promise<ResolvedChatAttachment> {
  const scope: SpaceScope = { orgId: request.orgId, spaceId: request.spaceId };
  const actor: Actor = { type: "user", id: request.userId };

  if (isFileUri(request.uri)) {
    const fileId = parseFileUri(request.uri);
    if (!fileId) throw invalidRequest(`Malformed file URI '${request.uri}'`);
    const resolved = await getFileForActor(scope, actor, fileId);
    if (!resolved) throw notFound(`File '${fileId}' not found`);
    const { row } = resolved;
    return { uri: fileUri(row.id), name: row.name, mime: row.mime, size: row.size };
  }

  const uploadId = parseUploadUri(request.uri);
  if (!uploadId) {
    throw invalidRequest(`Attachment URI must be an 'upload://' or 'appfile://' URI`);
  }
  const row = await createFileFromUpload(scope, actor, uploadId, {
    chatSessionId: request.chatSessionId,
  });
  return { uri: fileUri(row.id), name: row.name, mime: row.mime, size: row.size };
}

// ---------------------------------------------------------------------------
// List (gallery)
// ---------------------------------------------------------------------------

export interface ListFilesFilters {
  purpose?: FilePurpose;
  packageId?: string;
  runId?: string;
  chatSessionId?: string;
  contextChatSessionId?: string;
  limit?: number;
  startingAfter?: string;
}

/**
 * The `run_id` filter clause for the file gallery. A run's files are not
 * only the ones it PRODUCED (`files.run_id = run`) — a run also CONSUMES
 * files passed as input (`appfile://file_xxx` references in `runs.input`),
 * whose own container is wherever they were first materialized (a chat session,
 * or another run). So the filter is the union: rows anchored to the run, OR rows
 * whose id is referenced by the run's input JSONB.
 *
 * The run lookup is `getRun(scope, runId)` — the SAME org+space scoping every other
 * run read uses — so a run id from another org/space resolves to null and its input
 * refs never widen the result (no cross-tenant leak; the referenced-id `inArray`
 * is AND-ed with the caller's org/space/actor scope on `files` regardless).
 * When the run has no input or no file refs, this collapses to the original
 * plain `run_id =` equality — behavior unchanged.
 */
async function runContainerFilter(scope: SpaceScope, runId: string): Promise<SQL> {
  const run = await getRun(scope, runId);
  const inputDocIds = run ? extractFileIds(run.input) : [];
  if (inputDocIds.length === 0) return eq(files.runId, runId);
  return or(eq(files.runId, runId), inArray(files.id, inputDocIds))!;
}

/**
 * Files that make up one conversation's context: direct chat attachments,
 * outputs produced by its runs, and files consumed by those runs. The
 * session ownership check is load-bearing because chat sessions are private
 * even though dashboard members may read the org-wide run list.
 */
async function chatContextFileFilter(
  scope: SpaceScope,
  actor: Actor,
  chatSessionId: string,
): Promise<SQL> {
  if (actor.type !== "user") return sql`false`;

  const [session] = await db
    .select({ id: chatSessions.id })
    .from(chatSessions)
    .where(
      and(
        eq(chatSessions.id, chatSessionId),
        eq(chatSessions.orgId, scope.orgId),
        // Sessions are space-scoped rows (RBAC spec §5), so the space is part
        // of ownership: the same user in another space must not resolve this
        // conversation's files.
        eq(chatSessions.spaceId, scope.spaceId),
        eq(chatSessions.userId, actor.id),
      ),
    )
    .limit(1);
  if (!session) return sql`false`;

  return or(
    eq(files.chatSessionId, chatSessionId),
    exists(
      db
        .select({ id: runs.id })
        .from(runs)
        .where(
          and(
            eq(files.runId, runs.id),
            eq(runs.orgId, scope.orgId),
            eq(runs.spaceId, scope.spaceId),
            eq(runs.chatSessionId, chatSessionId),
          ),
        ),
    ),
    exists(
      db
        .select({ fileId: fileLinks.fileId })
        .from(fileLinks)
        .innerJoin(runs, eq(fileLinks.consumerRunId, runs.id))
        .where(
          and(
            eq(fileLinks.fileId, files.id),
            eq(fileLinks.orgId, scope.orgId),
            eq(runs.orgId, scope.orgId),
            eq(runs.spaceId, scope.spaceId),
            eq(runs.chatSessionId, chatSessionId),
          ),
        ),
    ),
  )!;
}

/**
 * Org+space-scoped file gallery, with container-inherited visibility (D7 —
 * consistent with `getFileForActor`):
 *
 *  - A dashboard `user` (member) sees every run-contained file in the space
 *    (mirroring the org-wide runs list — no per-user filter), plus chat-contained
 *    files only from their OWN sessions (chat sessions are private).
 *  - An `end_user` sees only their own rows (`actorScopeFilter`).
 *
 * Keyset pagination on `(createdAt, id)` DESC — the same stable tuple cursor as
 * the end-users list.
 */
export async function listFilesForActor(
  scope: SpaceScope,
  actor: Actor,
  filters: ListFilesFilters = {},
  permissions: ReadonlySet<string> = new Set(),
): Promise<ListEnvelope<FileDto>> {
  const limit = Math.min(Math.max(filters.limit ?? 20, 1), 100);
  const fetchLimit = limit + 1;

  const conditions: SQL[] = [
    eq(files.orgId, scope.orgId),
    eq(files.spaceId, scope.spaceId),
    actor.type === "end_user"
      ? actorScopeFilter(actor, { userId: files.userId, endUserId: files.endUserId })
      : // Members — three visibility arms so a detached (both containers NULL)
        // `user_upload` is NOT widened by deletion (it was creator-only in its
        // chat/run origin and stays so):
        //   1. run-contained (run_id set) → org-wide, mirroring the runs list;
        //   2. own rows (user_id = me) → own chat docs + own detached uploads;
        //   3. detached `agent_output` → org-readable (it always was, via its run).
        // A chat-contained doc (chat_session_id set, run_id null) is covered by
        // arm 2 only — unchanged owner-only visibility.
        or(
          isNotNull(files.runId),
          eq(files.userId, actor.id),
          and(isNull(files.runId), isNull(files.chatSessionId), eq(files.purpose, "agent_output")),
        )!,
  ];
  if (filters.purpose) conditions.push(eq(files.purpose, filters.purpose));
  if (filters.packageId) conditions.push(eq(files.packageId, filters.packageId));
  if (filters.runId) conditions.push(await runContainerFilter(scope, filters.runId));
  if (filters.chatSessionId) conditions.push(eq(files.chatSessionId, filters.chatSessionId));
  if (filters.contextChatSessionId) {
    conditions.push(await chatContextFileFilter(scope, actor, filters.contextChatSessionId));
  }

  if (filters.startingAfter) {
    const [cursor] = await db
      .select({ createdAt: files.createdAt, id: files.id })
      .from(files)
      .where(
        and(
          eq(files.id, filters.startingAfter),
          eq(files.orgId, scope.orgId),
          eq(files.spaceId, scope.spaceId),
        ),
      )
      .limit(1);
    // Next page (older rows), DESC order: (createdAt, id) < (cursor.createdAt, cursor.id).
    // A cursor id that no longer exists drops its clause — the page just starts
    // at the head rather than erroring.
    if (cursor) {
      conditions.push(
        or(
          lt(files.createdAt, cursor.createdAt),
          and(eq(files.createdAt, cursor.createdAt), lt(files.id, cursor.id)),
        )!,
      );
    }
  }

  const rows = await db
    .select(fileSelect)
    .from(files)
    .where(and(...conditions))
    .orderBy(desc(files.createdAt), desc(files.id))
    .limit(fetchLimit);

  const canManage = permissions.has("files:delete");
  const hasMore = rows.length > limit;
  const data = (hasMore ? rows.slice(0, limit) : rows).map((r) => {
    const row = r as FileRow;
    // Every row passed the visibility SQL, so `visible: true`. No `mintPreview` —
    // list rows carry only the `previewable` boolean; the signed preview token is
    // minted on the single-file GET.
    const capabilities = getFileCapabilities(row, actor, { visible: true, canManage });
    return toFileDto(row, actor, capabilities);
  });
  return { ...listResponse(data, { hasMore }), limit };
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/**
 * Container-teardown for a deleted run set, chat session, or end-user: decide,
 * per contained file, whether to DETACH it (a live consumer outside the
 * deleted set still references it — the "durable & chainable" promise) or DELETE
 * it (nothing else needs it). Replaces the blind FK cascade for these
 * user-driven delete paths so a consumed doc survives its producer's deletion,
 * and an unconsumed one frees its bytes + storage object.
 *
 *  - PROTECTED (run variant): a `file_links` row whose `consumer_run_id` is
 *    NOT in the deleted set — a live run still consumes it → detach (`run_id =
 *    NULL`); bytes, counter, and id untouched.
 *  - PROTECTED (chat variant): ANY link at all — the consumer is always a run,
 *    never the chat session itself → detach (`chat_session_id = NULL`).
 *  - PROTECTED (end-user variant): ANY link at all — runs SURVIVE an end-user
 *    deletion (`runs.end_user_id` is SET NULL), so every link is by definition
 *    a live consumer → detach (`end_user_id = NULL`, dropping only the
 *    attribution the deleted principal carried).
 *  - UNPROTECTED → delete the row, decrement the org counter, and enqueue the
 *    storage purge — all in the same transaction (same contract as
 *    {@link deleteFile}).
 *
 * LOCK ORDER — org row FIRST, then the files. Every file WRITE
 * (`createFileFromStream`) locks the org row before inserting, and every
 * parent cascade (organization / space / end-user delete) locks the org
 * before enumerating. A teardown that locked files first and only touched
 * `organizations` later through the counter update would form the other half of
 * an ABBA cycle with those cascades. Taking the org lock here also serializes
 * this teardown against a concurrent publish: either we see the new file
 * (and delete it + enqueue its job), or the publish's insert fails the FK
 * against the by-then-deleted parent and drops its own object.
 *
 * The run and end-user variants carry their `orgId` explicitly: both callers
 * already resolved it (it is the space scope they are authorized against) and
 * already hold that very org lock, so re-deriving it from the container rows
 * would only be a second read of a value the caller had all along. The chat
 * variant crosses the module boundary with the session id alone, so its org is
 * looked up here.
 *
 * The caller MUST invoke this BEFORE deleting the runs/session/end-user, else
 * the FK cascade destroys the `files` rows (and their links) first.
 */
export async function detachOrDeleteContainedFiles(
  container:
    | { runIds: string[]; orgId: string }
    | { chatSessionId: string }
    | { endUserId: string; orgId: string },
  tx?: DbOrTx,
): Promise<void> {
  const runIds = "runIds" in container ? container.runIds : null;
  // An empty run set contains nothing — skip the transaction entirely.
  if (runIds && runIds.length === 0) return;
  const chatSessionId = "chatSessionId" in container ? container.chatSessionId : null;
  const endUserId = "endUserId" in container ? container.endUserId : null;

  const containedWhere = runIds
    ? inArray(files.runId, runIds)
    : chatSessionId
      ? eq(files.chatSessionId, chatSessionId)
      : eq(files.endUserId, endUserId!);

  const teardown = async (exec: DbOrTx): Promise<number> => {
    // Org-first (see the doc comment). One container, one org: supplied by the
    // caller, or read from the chat session for the module-boundary variant.
    let orgId: string | null = "orgId" in container ? container.orgId : null;
    if (orgId === null) {
      const [session] = await exec
        .select({ orgId: chatSessions.orgId })
        .from(chatSessions)
        .where(eq(chatSessions.id, chatSessionId!))
        .limit(1);
      orgId = session?.orgId ?? null;
    }
    if (orgId !== null) {
      await exec
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .for("update")
        .limit(1);
    }

    const contained = await exec
      .select({ id: files.id })
      .from(files)
      .where(containedWhere)
      .for("update");
    if (contained.length === 0) return 0;
    const containedIds = contained.map((d) => d.id);

    // Protected = still referenced by a live consumer outside the deleted set.
    // One query (not per-row): the contained doc ids that carry such a link.
    const protectedRows = await exec
      .selectDistinct({ fileId: fileLinks.fileId })
      .from(fileLinks)
      .where(
        runIds
          ? and(
              inArray(fileLinks.fileId, containedIds),
              notInArray(fileLinks.consumerRunId, runIds),
            )
          : inArray(fileLinks.fileId, containedIds),
      );
    const protectedSet = new Set(protectedRows.map((r) => r.fileId));

    const detachIds = containedIds.filter((id) => protectedSet.has(id));
    const deleteIds = containedIds.filter((id) => !protectedSet.has(id));

    // Protected → detach.
    if (detachIds.length > 0) {
      await exec
        .update(files)
        .set(
          runIds ? { runId: null } : chatSessionId ? { chatSessionId: null } : { endUserId: null },
        )
        .where(inArray(files.id, detachIds));
    }

    if (deleteIds.length === 0) return 0;

    // Unprotected → delete rows + fold freed bytes back per org (a run set is one
    // org in practice, but group defensively — mirrors cleanupExpiredFiles).
    const removed = await exec.delete(files).where(inArray(files.id, deleteIds)).returning({
      orgId: files.orgId,
      size: files.size,
      storageKey: files.storageKey,
    });
    const perOrg = new Map<string, number>();
    for (const r of removed) perOrg.set(r.orgId, (perOrg.get(r.orgId) ?? 0) + r.size);
    for (const [orgId, bytes] of perOrg) await decrementOrgFileBytes(exec, orgId, bytes);

    // Transactional outbox: enqueue the storage purge in the SAME transaction as
    // the row delete, so a committed delete never orphans the object (replaces
    // the old best-effort post-commit delete).
    const jobs = removed
      .map((r) => storageKeyToDeletionJob(r.storageKey, "file_deleted"))
      .filter((j): j is StorageDeletionJobInput => j !== null);
    await enqueueStorageDeletion(exec, jobs);
    return removed.length;
  };

  // Run inside the caller's transaction when supplied (chat-session and
  // end-user teardown share the tx that deletes the parent row, making the two
  // atomic), else open our own.
  const deletedCount = tx ? await teardown(tx) : await db.transaction(teardown);
  recordFileDeleted(deletedCount);
}

/**
 * Delete a file: delete the row, decrement the org counter, and enqueue the
 * storage-object purge — ALL in one transaction. The enqueue (transactional
 * outbox) is atomic with the row delete, so the object can never be silently
 * orphaned: a committed delete always leaves a durable, replayable deletion job
 * that the background worker executes. Authorization (owner/admin permission OR
 * creator) is enforced by the caller.
 *
 * Org-first lock order (see {@link detachOrDeleteContainedFiles}): this
 * transaction ends up writing `organizations` through the counter decrement, so
 * it must take that row's lock BEFORE the file's — otherwise it holds a
 * `files` lock while waiting on an org lock that an org/space cascade
 * (which locks org → files) already holds, and Postgres kills one of the two.
 */
export async function deleteFile(scope: SpaceScope, fileId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, scope.orgId))
      .for("update")
      .limit(1);

    const [row] = await tx
      .select({ storageKey: files.storageKey })
      .from(files)
      .where(
        and(eq(files.id, fileId), eq(files.orgId, scope.orgId), eq(files.spaceId, scope.spaceId)),
      )
      .limit(1)
      .for("update");
    if (!row) throw notFound(`File '${fileId}' not found`);

    const [liveLink] = await tx
      .select({ fileId: fileLinks.fileId })
      .from(fileLinks)
      .where(eq(fileLinks.fileId, fileId))
      .limit(1);
    if (liveLink) {
      throw conflict(
        "file_in_use",
        "This file is referenced by one or more runs and cannot be deleted",
      );
    }

    const deleted = await tx
      .delete(files)
      .where(
        and(eq(files.id, fileId), eq(files.orgId, scope.orgId), eq(files.spaceId, scope.spaceId)),
      )
      .returning({ size: files.size });
    if (deleted.length === 0) throw notFound(`File '${fileId}' not found`);
    await decrementOrgFileBytes(tx, scope.orgId, deleted[0]!.size);

    const job = storageKeyToDeletionJob(row.storageKey, "file_deleted");
    if (job) await enqueueStorageDeletion(tx, job);
  });
  // Reaching here means the transaction committed exactly one row delete (it
  // throws otherwise) — count it.
  recordFileDeleted(1);
}

/**
 * Clear a file's retention deadline (`expires_at = NULL`) — the "keep"/pin
 * action (GitLab model): a file a caller explicitly keeps is exempted from
 * the expiry GC and never swept. Idempotent: pinning an already-permanent
 * file (NULL `expires_at`) is a no-op that returns the row unchanged.
 * Org+space scoped; authorization (creator OR `files:delete`) is enforced by
 * the caller (same rule as delete). Returns the updated row.
 */
export async function clearFileExpiry(scope: SpaceScope, fileId: string): Promise<FileRow> {
  const [row] = await db
    .update(files)
    .set({ expiresAt: null })
    .where(
      and(eq(files.id, fileId), eq(files.orgId, scope.orgId), eq(files.spaceId, scope.spaceId)),
    )
    .returning(fileSelect);
  if (!row) throw notFound(`File '${fileId}' not found`);
  return row as FileRow;
}

// ---------------------------------------------------------------------------
// GC — expired-file sweep
// ---------------------------------------------------------------------------

/**
 * Delete unreferenced files whose retention deadline has passed
 * (`expiresAt < now()`), in batches, ONE ORG AT A TIME. Linked files remain
 * durable until their consumer runs disappear. Returns the number of rows
 * removed.
 *
 * The sweep is org-scoped precisely so it can take the org row's lock BEFORE any
 * `files` lock — the same order every writer and every parent cascade uses
 * (see {@link detachOrDeleteContainedFiles}). A global batch could not: it
 * would lock files across orgs first and only reach `organizations` through
 * the counter decrement, which is exactly the ABBA cycle that made this
 * every-15-minutes sweep abort an organization or space deletion.
 */
export async function cleanupExpiredFiles(): Promise<number> {
  // Orgs holding at least one expired file. Read outside any transaction —
  // it only decides which orgs to visit; each org's set is re-read under its own
  // lock below.
  const orgRows = await db
    .selectDistinct({ orgId: files.orgId })
    .from(files)
    .where(and(isNotNull(files.expiresAt), lt(files.expiresAt, new Date())));

  let totalRemoved = 0;
  for (const { orgId } of orgRows) {
    while (true) {
      const removed = await db.transaction(async (tx) => {
        await tx
          .select({ id: organizations.id })
          .from(organizations)
          .where(eq(organizations.id, orgId))
          .for("update")
          .limit(1);

        const expired = await tx
          .select({ id: files.id })
          .from(files)
          .where(
            and(
              eq(files.orgId, orgId),
              isNotNull(files.expiresAt),
              lt(files.expiresAt, new Date()),
              notExists(
                tx
                  .select({ fileId: fileLinks.fileId })
                  .from(fileLinks)
                  .where(eq(fileLinks.fileId, files.id)),
              ),
            ),
          )
          .limit(500)
          .for("update", { skipLocked: true });
        if (expired.length === 0) return [];

        const ids = expired.map((r) => r.id);
        const linked = await tx
          .selectDistinct({ fileId: fileLinks.fileId })
          .from(fileLinks)
          .where(inArray(fileLinks.fileId, ids));
        const linkedIds = new Set(linked.map((row) => row.fileId));
        const removableIds = ids.filter((id) => !linkedIds.has(id));
        if (removableIds.length === 0) return [];

        const removed = await tx
          .delete(files)
          .where(inArray(files.id, removableIds))
          .returning({ size: files.size, storageKey: files.storageKey });
        const bytes = removed.reduce((sum, r) => sum + r.size, 0);
        if (bytes > 0) await decrementOrgFileBytes(tx, orgId, bytes);

        // Transactional outbox: enqueue the storage purge atomically with the row
        // delete (replaces the old best-effort post-commit delete).
        const jobs = removed
          // `file_expired` is the expiry-sweep sibling of `file_deleted` (see
          // `storage_deletion_jobs.reason`) — one label per cause, so an
          // operator's `GROUP BY reason` separates a user delete from a
          // retention sweep. Both were spelled `document_*` before the #1177
          // rename was finished at the physical layer.
          .map((r) => storageKeyToDeletionJob(r.storageKey, "file_expired"))
          .filter((j): j is StorageDeletionJobInput => j !== null);
        await enqueueStorageDeletion(tx, jobs);
        return removed;
      });
      if (removed.length === 0) break;
      recordFileDeleted(removed.length);
      totalRemoved += removed.length;
      if (removed.length < 500) break;
    }
  }
  return totalRemoved;
}

/**
 * Reconcile every org's `files_bytes_used` counter against the authoritative
 * `SUM(files.size)` and correct any drift. The counter is maintained
 * transactionally by file writes and the service-mediated parent deletion
 * paths. Legacy data, manual SQL, or an unmediated FK cascade can still bypass
 * that space-level accounting, so this pass remains a safety net. It
 * writes only orgs whose value differs. Each organization row is locked before
 * its SUM is read; file writes use the same lock, so reconciliation cannot
 * clobber a concurrent increment or decrement. Returns the number of orgs fixed.
 *
 * Note: this pass only corrects the byte COUNTER. The corresponding storage
 * objects are NOT orphaned by cascade deletes — the org / space / end-user
 * delete paths enumerate their files' storage keys and enqueue them into the
 * transactional deletion outbox (`storage_deletion_jobs`) before the cascade
 * drops the rows, so the objects are purged by the background worker. This
 * counter recompute remains as a defense-in-depth drift safety net. See
 * docs/architecture/FILES.md.
 */
export async function reconcileOrgFileBytes(): Promise<number> {
  let fixed = 0;
  let cursor: string | null = null;

  while (true) {
    const orgRows = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(cursor ? gt(organizations.id, cursor) : undefined)
      .orderBy(organizations.id)
      .limit(100);
    if (orgRows.length === 0) break;

    for (const { id } of orgRows) {
      const corrected = await db.transaction(async (tx) => {
        const [org] = await tx
          .select({ filesBytesUsed: organizations.filesBytesUsed })
          .from(organizations)
          .where(eq(organizations.id, id))
          .for("update");
        if (!org) return false;

        const [sumRow] = await tx
          .select({ bytes: sql<number>`COALESCE(SUM(${files.size}), 0)` })
          .from(files)
          .where(eq(files.orgId, id));
        const bytes = Number(sumRow?.bytes ?? 0);
        if (org.filesBytesUsed === bytes) return false;

        await tx
          .update(organizations)
          .set({ filesBytesUsed: bytes })
          .where(eq(organizations.id, id));
        return true;
      });
      if (corrected) fixed += 1;
    }

    cursor = orgRows.at(-1)!.id;
  }

  return fixed;
}

/** Aligned with the upload sweep cadence. */
const FILE_GC_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Run the counter reconciliation once every N sweep ticks (≈ daily at the 15-min
 * cadence). Low-frequency because it is a full correlated scan of `organizations`
 * — the transactional counter maintenance is the hot path; this is only the
 * drift safety net for cascade deletes.
 */
const FILE_RECONCILE_EVERY_N_TICKS = 96;

let gcTimer: ReturnType<typeof setInterval> | null = null;
let gcTicks = 0;

/**
 * Start the periodic file GC: an expired-file sweep every tick, plus a
 * low-frequency counter reconciliation pass (every N ticks). Safe to call
 * multiple times.
 */
export function startFileGc(): void {
  if (gcTimer) return;
  gcTimer = setInterval(() => {
    cleanupExpiredFiles()
      .then((count) => {
        if (count > 0) logger.info("Removed expired files", { count });
      })
      .catch((err) => {
        logger.warn("Periodic file GC failed", { error: getErrorMessage(err) });
      });
    if (gcTicks++ % FILE_RECONCILE_EVERY_N_TICKS === 0) {
      reconcileOrgFileBytes()
        .then((count) => {
          if (count > 0) logger.info("Reconciled org file-byte counters", { orgs: count });
        })
        .catch((err) => {
          logger.warn("File counter reconciliation failed", { error: getErrorMessage(err) });
        });
    }
  }, FILE_GC_INTERVAL_MS);
  gcTimer.unref?.();
}

/** Stop the periodic sweep. Called from the shutdown handler. */
export function stopFileGc(): void {
  if (gcTimer) {
    clearInterval(gcTimer);
    gcTimer = null;
    gcTicks = 0;
  }
}

/**
 * Stream a file's bytes (for the proxy-download path). Returns null when the
 * object is missing. Split out so the content route and any future consumer
 * share one code path.
 */
export function streamFileContent(storageKey: string): Promise<ReadableStream<Uint8Array> | null> {
  const parsed = parseStorageKey(storageKey);
  if (!parsed) return Promise.resolve(null);
  return storageDownloadStream(parsed.bucket, parsed.path);
}
