// SPDX-License-Identifier: Apache-2.0

import { pgTable, text, timestamp, check, boolean } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { user } from "./auth.ts";

export const profiles = pgTable(
  "profiles",
  {
    id: text("id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    displayName: text("display_name"),
    language: text("language").notNull(),
    /** The person's switch for the assistant's memory of them (`user_memories`). */
    assistantMemory: boolean("assistant_memory").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [check("language_check", sql`${table.language} IN ('fr', 'en')`)],
);
