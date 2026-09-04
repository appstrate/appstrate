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
import { spaces } from "./spaces.ts";
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
    /**
     * Space the session belongs to (RBAC spec §5). Nullable in this release
     * only: `scripts/migration/0008-org-viewer-to-guest.sql` backfills every
     * row to the org's default space and `0057` makes the column NOT NULL.
     * A NULL reaching the chat module is refused, never defaulted.
     */
    spaceId: text("space_id").references(() => spaces.id, { onDelete: "cascade" }),
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
    index("idx_chat_sessions_space_user").on(table.spaceId, table.userId),
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
 * `packages/module-chat/src/persistence.ts` is the ONLY writer: it persists the
 * user turn before inference starts and the assistant turn when the stream
 * finalizes, upserting on `(session_id, message_id)`. The server decides `seq`
 * (a `serial`); the client decides nothing.
 *
 * Ordering is `seq`, always — never `created_at`. Two messages in one turn can
 * share a clock tick; a `serial` cannot collide. The same reasoning already
 * governs `chat_sessions.lastAssistantSeq` / `lastReadSeq`, which are message
 * POINTERS into this column rather than timestamps.
 *
 * `format` and `parent_id` were dropped in migration 0054, on the grounds that
 * nothing READ them — not that their values were recoverable from what stays.
 * Both dated from the client-authoritative model this table used to serve,
 * where assistant-ui's native history adapter POSTed tree nodes shaped
 * `{ id, parent_id, format, content }` and the server stored what it was
 * handed; that endpoint never shipped, and 0054's header dates it and says what
 * a row it wrote would hold. Under the single linear server writer that
 * replaced it — the only writer any released build has had — `format` held one
 * constant and `parent_id` re-encoded `seq` order. Neither ever had a reader
 * that walked it, and neither carried an FK or a uniqueness constraint that
 * could have made one. If a second storage format ever ships it comes back with
 * a CHECK; if branching ever ships it needs a per-branch pointer WITH a
 * self-FK, not that column revived.
 *
 * The PARENT MESSAGE ID ITSELF is still computed, and still load-bearing — it
 * is one third of the material `deterministicMessageId` hashes for a UIMessage
 * that arrives without an id (`persistence.ts`). Dropping the column changed
 * nothing about that hash: the value is read from `lastMessageId` and passed
 * down exactly as before, it is simply no longer stored. Do not "simplify" that
 * argument away — every `gen_…` id already persisted was derived with it.
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
    content: jsonb("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("uq_chat_messages_session_message").on(table.sessionId, table.messageId),
    // Filter + sort for every thread read (migration 0052). All three readers
    // filter `session_id`; two then `ORDER BY seq` (ASC for the full thread,
    // DESC LIMIT 1 for the message the next turn follows, on the hot path
    // before inference). The UNIQUE index above serves the filter but orders by
    // `message_id` — a client-generated identity — so both sorted reads had to
    // sort. A btree walks backwards, so this one index serves both directions.
    // Not UNIQUE: `seq` is the PRIMARY KEY, so the pair is unique already.
    index("idx_chat_messages_session_seq").on(table.sessionId, table.seq),
  ],
);
