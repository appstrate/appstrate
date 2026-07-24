// SPDX-License-Identifier: Apache-2.0

import { pgTable, text, timestamp, integer, uuid, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { user } from "./auth.ts";
import { organizations } from "./organizations.ts";
import { applications, endUsers } from "./applications.ts";

/**
 * Tracks direct-upload requests before the binary has been consumed by a run.
 *
 * Flow:
 *  1. Client POST /api/uploads { name, size, mime, applicationId } → creates row, returns { uploadId, url, method, headers }
 *  2. Client PUT url ← binary (to S3 directly, or to /api/uploads/_content for FS)
 *  3. Client POST /api/agents/:id/run { input: { file: "upload://upl_xxx" } }
 *  4. Run pipeline streams upload:// into the run workspace, marks `consumedAt`
 *     (first consume only). The bytes stay retained and the URI re-consumable
 *     for a reuse window (UPLOAD_RETENTION_HOURS) so a re-triggered run
 *     (cancel → re-run, `rerun_from`) needs no re-upload.
 *  5. A GC worker later deletes rows (+ storage objects) that are expired and
 *     never consumed, or consumed longer than the reuse window ago.
 */
export const uploads = pgTable(
  "uploads",
  {
    /** `upl_` prefixed identifier (also used in upload:// URIs). */
    id: text("id").primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    applicationId: text("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    /** Better Auth user who requested the upload (null = end-user / unattributed). */
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    /**
     * End-user who requested the upload (null = dashboard-user context). Records
     * the creator identity for end-user-scoped flows so peek/consume can enforce
     * that only the uploading principal reads its own staged bytes — the
     * `createdBy` column only captures dashboard/API-key users.
     */
    endUserId: text("end_user_id").references(() => endUsers.id, { onDelete: "cascade" }),
    /** Storage key returned by the storage adapter (bucket/path). */
    storageKey: text("storage_key").notNull(),
    /** Original filename declared by the client. */
    name: text("name").notNull(),
    /** Declared MIME type (re-verified server-side via magic-byte sniffing). */
    mime: text("mime").notNull(),
    /** Size in bytes (declared, then verified on consumption). */
    size: integer("size").notNull(),
    /**
     * Optional client-declared SHA-256 of the payload (hex, lowercase). When
     * present it is enforced server-side: the S3 presign binds an
     * `x-amz-checksum-sha256` header (S3/MinIO verify on PUT), the proxy sink
     * re-hashes the streamed bytes, and consume/materialization compares the
     * hashed stream against it — a mismatch is rejected (400 `checksum_mismatch`)
     * before the object becomes visible or a document is committed. NULL = no
     * client integrity claim (behaviour identical to before this column existed).
     */
    sha256: text("sha256"),
    /** When the pre-signed URL expires and the row becomes eligible for GC. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /**
     * Stamped on the FIRST consume (never updated by re-consumes). NULL =
     * still orphan. Anchors the post-consume reuse window: the upload stays
     * re-consumable until `consumedAt + UPLOAD_RETENTION_HOURS`.
     */
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_uploads_app").on(table.applicationId),
    // Partial index matching the GC sweep predicate so consumed rows never
    // hit the index and the hot set stays tiny as uploads accumulate.
    index("idx_uploads_expires_unconsumed")
      .on(table.expiresAt)
      .where(sql`${table.consumedAt} IS NULL`),
  ],
);
