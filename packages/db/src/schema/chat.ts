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

// Messages are OPAQUE tree nodes written by assistant-ui's native history
// adapter (the client encodes each message with its format adapter and
// POSTs `{ id, parent_id, format, content }`): the server never interprets
// the payload beyond a best-effort title derivation. `parentId` carries the
// branching structure (regeneration/edit); `seq` preserves insertion order
// for tree reconstruction on load. Mirrors the appstrate-chat satellite's
// store (services/sessions.ts) on Postgres.
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
  (table) => [unique("uq_chat_messages_session_message").on(table.sessionId, table.messageId)],
);
