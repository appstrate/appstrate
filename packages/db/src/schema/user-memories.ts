// SPDX-License-Identifier: Apache-2.0

import { pgTable, text, timestamp, uuid, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { USER_MEMORY_TYPES } from "@appstrate/core/user-memory";
import { user } from "./auth.ts";
import { organizations } from "./organizations.ts";
import { chatSessions } from "./chat.ts";

/**
 * The assistant's memory of a PERSON (`@appstrate/core/user-memory`): one set
 * per platform user, across every organization they belong to. Deliberately
 * keyed on the user and nothing else (not a space, not a package, not a run),
 * so it follows the person from one organization to the next. An agent's
 * memory is `package_persistence`, a different thing.
 *
 * `orgId` is the ORIGIN and the boundary: NULL for what is about the person
 * themselves, read in every organization; else the organization the memory was
 * learned in, read in that organization only. What is learned in one
 * organization never reaches the assistant, nor the model provider, of another.
 *
 * Reachable by the person alone (`principalKind: "user"`): no org role grants
 * it, so no organization admin reads it.
 */
export const userMemories = pgTable(
  "user_memories",
  {
    id: text("id").primaryKey(), // mem_ prefix
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** Origin. NULL = about the person; else the organization it was learned in. */
    orgId: uuid("org_id").references(() => organizations.id, { onDelete: "cascade" }),
    type: text("type", { enum: USER_MEMORY_TYPES }).notNull(),
    /** Free label ("health", "Tastet", "accounting"): how one memory spans many topics. */
    subject: text("subject"),
    content: text("content").notNull(),
    /** The conversation it was written from, when the assistant wrote it. */
    sourceSessionId: text("source_session_id").references(() => chatSessions.id, {
      onDelete: "set null",
    }),
    /** `user` = written on the settings page, `assistant` = written by the chat. */
    createdBy: text("created_by", { enum: ["user", "assistant"] }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Every read narrows on the person first, then on the origin.
    index("idx_user_memories_user_org").on(table.userId, table.orgId),
    // FK-side indexes for the two cascades/set-nulls that scan this table.
    index("idx_user_memories_org")
      .on(table.orgId)
      .where(sql`${table.orgId} IS NOT NULL`),
    index("idx_user_memories_source_session")
      .on(table.sourceSessionId)
      .where(sql`${table.sourceSessionId} IS NOT NULL`),
    check(
      "user_memories_type_valid",
      sql`type IN ('preference', 'person', 'project', 'goal', 'commitment', 'fact')`,
    ),
    check("user_memories_created_by_valid", sql`created_by IN ('user', 'assistant')`),
  ],
);
