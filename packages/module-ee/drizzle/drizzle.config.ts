// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

import { defineConfig } from "drizzle-kit";
import { getTableName, isTable } from "drizzle-orm";
import * as schema from "./schema.ts";

// This module's tables live in the PLATFORM database, under their own journal
// (`drizzle.ee_migrations`) so drizzle-kit never reads or writes the platform's
// `drizzle.__drizzle_migrations`. Both must match `migrateEeDb` in `src/db.ts`.
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required to run this module's drizzle-kit commands");

export default defineConfig({
  schema: "./schema.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: { url },
  migrations: { table: "ee_migrations", schema: "drizzle" },
  // Read off the schema this config already points at: a table added there is
  // in the filter by the same edit, and the platform's tables — which share the
  // database and which drizzle-kit must never propose to drop — stay out of it.
  tablesFilter: Object.values(schema).filter(isTable).map(getTableName),
});
