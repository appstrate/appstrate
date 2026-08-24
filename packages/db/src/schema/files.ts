// SPDX-License-Identifier: Apache-2.0

import {
  pgTable,
  text,
  timestamp,
  bigint,
  uuid,
  index,
  uniqueIndex,
  primaryKey,
  check,
  foreignKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { filePurposeEnum } from "./enums.ts";
import { user } from "./auth.ts";
import { organizations } from "./organizations.ts";
import { applications, endUsers } from "./applications.ts";
import { runs } from "./runs.ts";
import { chatSessions } from "./chat.ts";

/**
 * Unified file store — durable, first-class deliverables and materialized user
 * uploads. One row per stored object, addressed by the opaque, lifelong
 * `appfile://file_xxx` URI (never re-minted; the pre-#1177 `document://`
 * spelling of the same URI is still read). Two origins share the table,
 * discriminated by `purpose`:
 *
 *  - `user_upload` — a staged `uploads` row materialized here the first time a
 *    run (or chat session) consumes it. The bytes move from the ephemeral
 *    `uploads` bucket to the durable files bucket; the persisted run
 *    input is rewritten `upload://` → `appfile://` so a rerun re-resolves from
 *    durable storage instead of the upload retention window.
 *  - `agent_output` — a deliverable an agent published from a run (Phase 2).
 *
 * Access is NEVER a per-file grant — it is inherited from the container at
 * check time (`getFileForActor`): a run-container file reuses the run's
 * read ACL (org+app scope + end-user guard); a chat-session-container file is
 * visible only to the session owner. `downloadable` is derived, not stored:
 * `purpose === 'agent_output' || creator === caller`.
 *
 * A file can be **detached** — both `runId` and `chatSessionId` NULL. This
 * happens when a container is deleted while OTHER live runs still consume the
 * file as input (tracked via `file_links`): rather than cascade-delete
 * a file a rerun still needs, the delete service-path NULLs the container and
 * the row survives. A detached file has no container to inherit an ACL from, so
 * the precedence chain falls back to org+app scope (`agent_output` stays
 * org-visible as it was via its run; a detached `user_upload` stays
 * creator-only via `userId`). The `chk_files_single_container` CHECK allows
 * at most one container — both NULL is legal, both set is not.
 *
 * The row id prefix is `file_`, minted by `prefixedId("file")`. It was `doc_`
 * until the #1177 rename was finished at the physical layer; the id shape is
 * pinned once in `FILE_ID_RE` (`@appstrate/core/file-uri`), which every
 * validator and URI parser reads.
 */
export const files = pgTable(
  "files",
  {
    /** `file_` prefixed identifier (also used in `appfile://` URIs). Stable for life. */
    id: text("id").primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    applicationId: text("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    purpose: filePurposeEnum("purpose").notNull(),
    /** Run container — inherits the run's read ACL. Null for chat-only files. */
    runId: text("run_id").references(() => runs.id, { onDelete: "cascade" }),
    /** Chat-session container — visible to the session owner only. Null otherwise. */
    chatSessionId: text("chat_session_id").references(() => chatSessions.id, {
      onDelete: "cascade",
    }),
    /**
     * Producing agent package id (gallery filter). No hard FK — packages can be
     * ephemeral (inline runs), so the reference is a free-text snapshot.
     */
    packageId: text("package_id"),
    /** Creator attribution (dashboard user), copied from the run/caller. */
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    /** Creator attribution (end-user), copied from the run/caller. */
    endUserId: text("end_user_id").references(() => endUsers.id, { onDelete: "cascade" }),
    /**
     * `files/{applicationId}/{fileId}/{safeName}` — the leading segment is the
     * bucket (`FILES_BUCKET`), which `parseStorageKey` splits back off at read
     * time. Bucket literal and stored key must agree; both were spelled
     * `documents` until migration `0044_finish_file_rename` moved them together.
     */
    storageKey: text("storage_key").notNull(),
    name: text("name").notNull(),
    mime: text("mime").notNull(),
    /** Size in bytes. bigint (mode: number) — a file can exceed the int4 ceiling. */
    size: bigint("size", { mode: "number" }).notNull(),
    /** SHA-256 of the bytes, computed while streaming. Integrity + future dedup. */
    sha256: text("sha256").notNull(),
    /** Retention deadline. NULL = permanent (default). Swept by the GC when < now(). */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Gallery list: WHERE org+app ORDER BY created_at DESC — a backward scan
    // over this composite serves the sort (same pattern as idx_runs_app_started).
    index("idx_files_org_app_created").on(table.orgId, table.applicationId, table.createdAt),
    // Run-container lookup + FK cascade scan on run delete.
    index("idx_files_run").on(table.runId),
    // Chat-container lookup + FK cascade scan on session delete.
    index("idx_files_chat_session").on(table.chatSessionId),
    // GC sweep predicate: partial index so permanent files (expiresAt NULL) —
    // the common case — never bloat the hot set the sweep scans.
    index("idx_files_expires")
      .on(table.expiresAt)
      .where(sql`${table.expiresAt} IS NOT NULL`),
    // Agent-output dedup: a run may re-publish the SAME (sha256, name) — the
    // at-least-once end-of-run sweep, or a retried POST. A partial UNIQUE index
    // makes that a hard invariant so two concurrent identical publishes cannot
    // double-insert (and double-count); the ingestion path catches the 23505 and
    // resolves it to the existing row (dedup 200). Scoped to `agent_output` so
    // `user_upload` rows (which legitimately repeat a name across runs) are
    // unaffected.
    uniqueIndex("uq_files_run_output_dedup")
      .on(table.runId, table.sha256, table.name)
      .where(sql`${table.purpose} = 'agent_output'`),
    // FK-side index for the `end_users` cascade. Postgres indexes the
    // REFERENCED side of a foreign key, never the referencing one, so without
    // this every end-user deletion seq-scans the whole of `files` while
    // holding its locks. Partial (`IS NOT NULL`): dashboard-user files —
    // the common case — never enter the index.
    index("idx_files_end_user")
      .on(table.endUserId)
      .where(sql`${table.endUserId} IS NOT NULL`),
    // No index on `user_id`: it is only ever read ANDed under `org_id` +
    // `application_id` (`listFilesForActor`), which
    // `idx_files_org_app_created` already serves, and there is no
    // user-deletion path in the platform for its SET NULL action to scan.
    // Same reasoning for the `applications` cascade. NOT covered by
    // `idx_files_org_app_created`: `application_id` is not that index's
    // LEADING column, so it cannot serve an application-only lookup.
    index("idx_files_application").on(table.applicationId),
    // Referenced target of `file_links`' composite tenant-integrity FK.
    // Trivially valid — `id` alone is the PK, so `(id, org_id)` can never
    // collide; it only costs an index build.
    uniqueIndex("uq_files_id_org_id").on(table.id, table.orgId),
    // Tenant-integrity FK (same pattern as CRIT-07 on `llm_usage`): a
    // file's run container is inseparable from its `org_id`, so a
    // caller-supplied run id can never file a row under another tenant's
    // run. There is NO row-level security in this platform — the database is
    // the last line of defence, and the single-column `run_id` FK above proves
    // only that the run exists, not that it belongs to the same org.
    // NULL `run_id` rows (chat-container or detached files) pass per MATCH
    // SIMPLE. ON DELETE cascade deliberately MIRRORS the single-column FK
    // above: a run delete normally goes through the service path, which
    // detaches files still consumed by live runs (`file_links`) BEFORE
    // deleting; the cascade is the fallback for the unprotected remainder.
    // Created (and validated — the table is empty) in migration 0029.
    foreignKey({
      name: "files_run_id_org_id_fk",
      columns: [table.runId, table.orgId],
      foreignColumns: [runs.id, runs.orgId],
    }).onDelete("cascade"),
    // Tenant-integrity FK for the chat container — mirror of the run FK above.
    foreignKey({
      name: "files_chat_session_id_org_id_fk",
      columns: [table.chatSessionId, table.orgId],
      foreignColumns: [chatSessions.id, chatSessions.orgId],
    }).onDelete("cascade"),
    // At most one container. Both set is a modelling error (which ACL wins?);
    // both NULL is the legal "detached" state (see the table doc). Not an XOR:
    // detachment must be reachable.
    check(
      "chk_files_single_container",
      sql`NOT (${table.runId} IS NOT NULL AND ${table.chatSessionId} IS NOT NULL)`,
    ),
  ],
);

/**
 * Cross-container consumption links — which OTHER runs consume a file as
 * input. Written at input-parse time (`appfile://` resolution), and ONLY when
 * the consumer is a different container than the producer (`file.runId !==
 * consumerRunId`) — a run's own outputs never link to themselves.
 *
 * This is the chaining-protection ledger: the "durable & chainable" promise
 * means run B can consume `appfile://file_x` produced by run A. When A's runs
 * are deleted, the delete service-path consults these links — a file still
 * consumed by a live run outside the deleted set is DETACHED (container NULLed,
 * see `files`) instead of cascade-deleted, so B's rerun still resolves it.
 *
 * Both FKs cascade: the link dies with the file (`fileId`) or with the
 * consuming run (`consumerRunId`). The row is pure derived state — losing it
 * only means the file is no longer protected by that consumer, which is exactly
 * correct once the consumer is gone.
 *
 * `orgId` is carried denormalized for ONE reason: tenant integrity. This table
 * decides detach-vs-delete, and the delete path queries it by `fileId`
 * alone (`deleteFile` / `deleteFilesForContainer`) with no org filter —
 * so a single link row written across a tenant boundary would let org B's run
 * permanently block org A from deleting its own file. The two composite FKs
 * below make such a row structurally unrepresentable: the file AND the
 * consuming run must both belong to the org named on the link.
 */
export const fileLinks = pgTable(
  "file_links",
  {
    fileId: text("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    consumerRunId: text("consumer_run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    /**
     * Owning org — the ONE org that both the file and the consuming run
     * belong to. No single-column FK to `organizations`: the composite FKs
     * below already root this column in two org-cascading parents, so an org
     * deletion reaches these rows through `files` / `runs`.
     */
    orgId: uuid("org_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.fileId, table.consumerRunId] }),
    // Reverse lookup + FK cascade scan on run delete: "what files does this run
    // consume?" (the composite PK already covers the by-file direction,
    // and therefore also both composite FKs' referencing side.)
    index("idx_file_links_consumer_run").on(table.consumerRunId),
    // Tenant-integrity FKs — the link's file and its consuming run must
    // both be the org named on the row. Without them a cross-tenant link is
    // insertable and turns into a denial of deletion for the victim org (see
    // the table doc). Created in migration 0029; both tables are empty in
    // production, so the validation scan is free.
    foreignKey({
      name: "file_links_file_id_org_id_fk",
      columns: [table.fileId, table.orgId],
      foreignColumns: [files.id, files.orgId],
    }).onDelete("cascade"),
    foreignKey({
      name: "file_links_consumer_run_id_org_id_fk",
      columns: [table.consumerRunId, table.orgId],
      foreignColumns: [runs.id, runs.orgId],
    }).onDelete("cascade"),
  ],
);
