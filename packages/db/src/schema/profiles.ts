import { pgTable, text, timestamp, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { user } from "./auth.ts";

export const profiles = pgTable(
  "profiles",
  {
    id: text("id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    displayName: text("display_name"),
    language: text("language").notNull().default("fr"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [check("language_check", sql`${table.language} IN ('fr', 'en')`)],
);
