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
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { documentPurposeEnum } from "./enums.ts";
import { user } from "./auth.ts";
import { organizations } from "./organizations.ts";
import { applications, endUsers } from "./applications.ts";
import { runs } from "./runs.ts";
import { chatSessions } from "./chat.ts";

/**
 * Unified document store — durable, first-class deliverables and materialized
 * user uploads. One row per stored object, addressed by the opaque, lifelong
 * `document://doc_xxx` URI (never re-minted). Two origins share the table,
 * discriminated by `purpose`:
 *
 *  - `user_upload` — a staged `uploads` row materialized here the first time a
 *    run (or chat session) consumes it. The bytes move from the ephemeral
 *    `uploads` bucket to the durable `documents` bucket; the persisted run
 *    input is rewritten `upload://` → `document://` so a rerun re-resolves from
 *    durable storage instead of the upload retention window.
 *  - `agent_output` — a deliverable an agent published from a run (Phase 2).
 *
 * Access is NEVER a per-file grant — it is inherited from the container at
 * check time (`getDocumentForActor`): a run-container doc reuses the run's
 * read ACL (org+app scope + end-user guard); a chat-session-container doc is
 * visible only to the session owner. `downloadable` is derived, not stored:
 * `purpose === 'agent_output' || creator === caller`.
 *
 * A document can be **detached** — both `runId` and `chatSessionId` NULL. This
 * happens when a container is deleted while OTHER live runs still consume the
 * document as input (tracked via `document_links`): rather than cascade-delete
 * a doc a rerun still needs, the delete service-path NULLs the container and
 * the row survives. A detached doc has no container to inherit an ACL from, so
 * the precedence chain falls back to org+app scope (`agent_output` stays
 * org-visible as it was via its run; a detached `user_upload` stays
 * creator-only via `userId`). The `chk_documents_single_container` CHECK allows
 * at most one container — both NULL is legal, both set is not.
 */
export const documents = pgTable(
  "documents",
  {
    /** `doc_` prefixed identifier (also used in `document://` URIs). Stable for life. */
    id: text("id").primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    applicationId: text("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    purpose: documentPurposeEnum("purpose").notNull(),
    /** Run container — inherits the run's read ACL. Null for chat-only docs. */
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
    /** `documents/{applicationId}/{documentId}/{safeName}` in the documents bucket. */
    storageKey: text("storage_key").notNull(),
    name: text("name").notNull(),
    mime: text("mime").notNull(),
    /** Size in bytes. bigint (mode: number) — a document can exceed the int4 ceiling. */
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
    index("idx_documents_org_app_created").on(table.orgId, table.applicationId, table.createdAt),
    // Run-container lookup + FK cascade scan on run delete.
    index("idx_documents_run").on(table.runId),
    // Chat-container lookup + FK cascade scan on session delete.
    index("idx_documents_chat_session").on(table.chatSessionId),
    // GC sweep predicate: partial index so permanent docs (expiresAt NULL) —
    // the common case — never bloat the hot set the sweep scans.
    index("idx_documents_expires")
      .on(table.expiresAt)
      .where(sql`${table.expiresAt} IS NOT NULL`),
    // Agent-output dedup: a run may re-publish the SAME (sha256, name) — the
    // at-least-once end-of-run sweep, or a retried POST. A partial UNIQUE index
    // makes that a hard invariant so two concurrent identical publishes cannot
    // double-insert (and double-count); the ingestion path catches the 23505 and
    // resolves it to the existing row (dedup 200). Scoped to `agent_output` so
    // `user_upload` rows (which legitimately repeat a name across runs) are
    // unaffected.
    uniqueIndex("uq_documents_run_output_dedup")
      .on(table.runId, table.sha256, table.name)
      .where(sql`${table.purpose} = 'agent_output'`),
    // At most one container. Both set is a modelling error (which ACL wins?);
    // both NULL is the legal "detached" state (see the table doc). Not an XOR:
    // detachment must be reachable.
    check(
      "chk_documents_single_container",
      sql`NOT (${table.runId} IS NOT NULL AND ${table.chatSessionId} IS NOT NULL)`,
    ),
  ],
);

/**
 * Cross-container consumption links — which OTHER runs consume a document as
 * input. Written at input-parse time (`document://` resolution), and ONLY when
 * the consumer is a different container than the producer (`doc.runId !==
 * consumerRunId`) — a run's own outputs never link to themselves.
 *
 * This is the chaining-protection ledger: the "durable & chainable" promise
 * means run B can consume `document://doc_x` produced by run A. When A's runs
 * are deleted, the delete service-path consults these links — a doc still
 * consumed by a live run outside the deleted set is DETACHED (container NULLed,
 * see `documents`) instead of cascade-deleted, so B's rerun still resolves it.
 *
 * Both FKs cascade: the link dies with the document (`documentId`) or with the
 * consuming run (`consumerRunId`). The row is pure derived state — losing it
 * only means the doc is no longer protected by that consumer, which is exactly
 * correct once the consumer is gone.
 */
export const documentLinks = pgTable(
  "document_links",
  {
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    consumerRunId: text("consumer_run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.documentId, table.consumerRunId] }),
    // Reverse lookup + FK cascade scan on run delete: "what docs does this run
    // consume?" (the composite PK already covers the by-document direction).
    index("idx_document_links_consumer_run").on(table.consumerRunId),
  ],
);
