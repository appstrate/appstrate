// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

import { defineConfig } from "drizzle-kit";
import { getTableName, isTable } from "drizzle-orm";
import * as schema from "./schema.ts";

// These tables live in the PLATFORM database under their own journal
// (`drizzle.appstrate_ee_migrations`), distinct from the platform's and from
// module-ee's. Both must match `migrateEeDb` in `src/db.ts`.
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required to run this package's drizzle-kit commands");

export default defineConfig({
  schema: "./schema.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: { url },
  migrations: { table: "appstrate_ee_migrations", schema: "drizzle" },
  // Only this package's tables: drizzle-kit must never propose dropping the platform's.
  tablesFilter: Object.values(schema).filter(isTable).map(getTableName),
});
