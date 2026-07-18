// SPDX-License-Identifier: Apache-2.0

import { pgTable, text, timestamp, jsonb, uuid, index, serial, unique } from "drizzle-orm/pg-core";
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
    // Read-state watermarks. `lastAssistantAt` advances only when an assistant
    // message persists; `lastReadAt` advances when the owner marks the session
    // read (or sends a message — sending implies having seen the thread). A
    // session is unread when lastAssistantAt > lastReadAt; the comparison lives
    // server-side in the DTO so no timestamps cross the wire.
    lastAssistantAt: timestamp("last_assistant_at", { withTimezone: true }),
    lastReadAt: timestamp("last_read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_chat_sessions_org_user").on(table.orgId, table.userId)],
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
