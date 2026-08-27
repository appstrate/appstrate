// SPDX-License-Identifier: Apache-2.0

import {
  pgTable,
  text,
  timestamp,
  jsonb,
  uuid,
  index,
  integer,
  serial,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations.ts";
import { user } from "./auth.ts";

// Chat tables — owned by the core schema (modules own no tables), consumed by
// the `@appstrate/module-chat` workspace module. Created by the system
// migration pipeline at boot; they exist regardless of whether the chat
// module is loaded in `MODULES`. Behavior (routes, RBAC, UI) lives in
// `packages/module-chat`.

export const chatSessions = pgTable(
  "chat_sessions",
  {
    id: text("id").primaryKey(), // chs_ prefix
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    // onDelete cascade + files cascade with the session: no path deletes
    // `user` rows today, but any FUTURE user-deletion feature MUST route through
    // a service that first enumerates this user's session files into the
    // storage-deletion outbox (`storage_deletion_jobs`) — same contract as
    // space / end-user deletion (see spaces.ts / end-users.ts).
    // A raw `DELETE FROM "user"` would cascade the files with no outbox
    // job and orphan their S3 objects forever.
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    title: text("title"),
    // Id of the in-flight resumable stream for this session, or null when no
    // turn is generating. Set when a `POST /api/chat` turn starts, cleared when
    // it finalizes. The resume endpoint (`GET /sessions/:id/stream`) reconnects
    // a reloaded client to the live stream by this id; a stale/orphaned id (no
    // live producer in the store) is treated as "no active stream" (204).
    activeStreamId: text("active_stream_id"),
    // Read-state watermarks as MESSAGE POINTERS (`chat_messages.seq`), the
    // read-marker model used by Slack/Discord/Matrix: ordering comes from
    // message insertion, never from a clock. `lastAssistantSeq` advances only
    // when an assistant message persists; `lastReadSeq` advances monotonically
    // (GREATEST) when the owner marks the session read — or sends a message,
    // since sending implies having seen the thread. A session is unread when
    // lastAssistantSeq > lastReadSeq; the comparison lives server-side in the
    // DTO so only a boolean crosses the wire.
    lastAssistantSeq: integer("last_assistant_seq"),
    lastReadSeq: integer("last_read_seq"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_chat_sessions_org_user").on(table.orgId, table.userId),
    // Referenced target of the composite tenant-integrity FK on
    // `llm_usage(chat_session_id, org_id)`: Postgres needs a unique index
    // covering exactly these columns for the FK to attach. Trivially valid —
    // `id` alone is the PK, so `(id, org_id)` can never collide.
    uniqueIndex("uq_chat_sessions_id_org_id").on(table.id, table.orgId),
  ],
);

/**
 * One row per chat message, written SERVER-SIDE and in insertion order.
 *
 * The comment this replaces described a client-authoritative model that no
 * longer exists: messages as opaque tree nodes POSTed by assistant-ui's native
 * history adapter as `{ id, parent_id, format, content }`, with the server
 * merely storing what it was handed. That path was deleted. Today
 * `packages/module-chat/src/persistence.ts` is the ONLY writer: it persists the
 * user turn before inference starts and the assistant turn when the stream
 * finalizes, upserting on `(session_id, message_id)`. The server decides `seq`
 * (a `serial`), the server decides `format`, and the server decides `parent_id`.
 *
 * Ordering is `seq`, always — never `created_at`. Two messages in one turn can
 * share a clock tick; a `serial` cannot collide. The same reasoning already
 * governs `chat_sessions.lastAssistantSeq` / `lastReadSeq`, which are message
 * POINTERS into this column rather than timestamps.
 *
 * ── TWO COLUMNS THAT NO LONGER CARRY INFORMATION ────────────────────────────
 *
 * Recorded here rather than acted on: both are still echoed to the client, so
 * removing either is a coordinated change with `packages/module-chat`, which
 * this pass does not own.
 *
 * `format` — a server constant. `persistence.ts` writes `CHAT_MESSAGE_FORMAT`
 * at both the insert and the conflict-update, and nothing else writes the
 * column, so it has exactly one possible value in every row that exists. It was
 * a discriminator back when the CLIENT chose its format adapter; with a single
 * server writer it discriminates nothing. Removing it takes: dropping it from
 * the persisted DTO in `module-chat/src/routes.ts`, confirming no client reads
 * it back, then a migration. If a second format ever ships, the column comes
 * back with a CHECK — it should not be kept on the chance that it might.
 *
 * `parent_id` — a redundant re-encoding of `seq` order. It exists to carry
 * branching (regeneration / edit), but the only writer is linear:
 * `persistUserMessage` chains onto `lastMessageId(sessionId)` (the highest
 * `seq`) and `persistAssistantMessage` chains onto the user turn that prompted
 * it. Under a linear writer, `parent_id` is always "the previous message", i.e.
 * exactly what `ORDER BY seq` already gives, and no reader reconstructs a tree
 * from it. It is also unconstrained — no FK, no uniqueness — so nothing stops a
 * cycle or a dangling parent. Removing it takes: dropping it from the DTO and
 * from `upsertMessage`'s insert/update, plus the `parentId` argument threaded
 * through `persistAssistantMessage`, then a migration. If real branching ships,
 * what it needs is a per-branch pointer WITH a self-FK — not this column
 * revived.
 *
 * Neither is a correctness bug today. They are both dead weight that reads as
 * capability, which is the thing that makes the next reader model a tree that
 * is not there.
 */
export const chatMessages = pgTable(
  "chat_messages",
  {
    seq: serial("seq").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    /** Client-generated message id (the format adapter's identity). */
    messageId: text("message_id").notNull(),
    parentId: text("parent_id"),
    format: text("format").notNull(),
    content: jsonb("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uq_chat_messages_session_message").on(table.sessionId, table.messageId),
    // Filter + sort for every thread read (migration 0052). All three readers
    // filter `session_id`; two then `ORDER BY seq` (ASC for the full thread,
    // DESC LIMIT 1 for the parent of the next turn, on the hot path before
    // inference). The UNIQUE index above serves the filter but orders by
    // `message_id` — a client-generated identity — so both sorted reads had to
    // sort. A btree walks backwards, so this one index serves both directions.
    // Not UNIQUE: `seq` is the PRIMARY KEY, so the pair is unique already.
    index("idx_chat_messages_session_seq").on(table.sessionId, table.seq),
  ],
);
