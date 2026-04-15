// SPDX-License-Identifier: Apache-2.0

import { pgTable, text, timestamp, integer, uuid, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { user } from "./auth.ts";
import { organizations } from "./organizations.ts";
import { applications } from "./applications.ts";

/**
 * Tracks direct-upload requests before the binary has been consumed by a run.
 *
 * Flow:
 *  1. Client POST /api/uploads { name, size, mime, applicationId } → creates row, returns { uploadId, url, method, headers }
 *  2. Client PUT url ← binary (to S3 directly, or to /api/uploads/_content for FS)
 *  3. Client POST /api/agents/:id/run { input: { file: "upload://upl_xxx" } }
 *  4. Run pipeline resolves upload:// → buffer, marks `consumedAt`.
 *  5. A GC worker later deletes rows where expiresAt < now() AND consumedAt IS NULL.
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
    /** Better Auth user who requested the upload (null = API key / end-user context). */
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    /** Storage key returned by the storage adapter (bucket/path). */
    storageKey: text("storage_key").notNull(),
    /** Original filename declared by the client. */
    name: text("name").notNull(),
    /** Declared MIME type (re-verified server-side via magic-byte sniffing). */
    mime: text("mime").notNull(),
    /** Size in bytes (declared, then verified on consumption). */
    size: integer("size").notNull(),
    /** When the pre-signed URL expires and the row becomes eligible for GC. */
    expiresAt: timestamp("expires_at").notNull(),
    /** Set when a run has consumed the file. NULL = still orphan. */
    consumedAt: timestamp("consumed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
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
