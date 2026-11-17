// SPDX-License-Identifier: Apache-2.0

/**
 * The database a window script (`0040`, `0041`, `0043`, `0044`, `0045`, `0048`) targets: `DATABASE_URL`, or an embedded database
 * named by `PGLITE_DATA_DIR` (the platform stopped: PGlite opens in one process). With neither set,
 * `@appstrate/db/client` would open the default `./data/pglite`, so the entry point calls this
 * before importing it, and exits 2.
 */
export function exitUnlessDatabaseNamed(): void {
  if (process.env.DATABASE_URL || process.env.PGLITE_DATA_DIR) return;
  process.stdout.write(
    "neither DATABASE_URL nor PGLITE_DATA_DIR is set — refusing the default ./data/pglite; " +
      "load the .env, or name an embedded database with PGLITE_DATA_DIR\n",
  );
  process.exit(2);
}

/**
 * The line naming the database a script writes to: the PostgreSQL database and its server, or
 * the resolved `PGLITE_DATA_DIR` of an embedded database.
 */
export async function describeDatabaseTarget(): Promise<string> {
  // Imported here: `@appstrate/db/client` opens its database on import, after the entry point's guard.
  const { db, getPGliteClient, toRows } = await import("@appstrate/db/client");
  const pglite = getPGliteClient();
  if (pglite) return `database: PGlite at ${pglite.dataDir}`;
  const [target] = toRows<{ name: string; addr: string | null; port: number | null }>(
    await db.execute(
      "SELECT current_database() AS name, inet_server_addr()::text AS addr, inet_server_port() AS port",
    ),
  );
  return `database: ${target!.name} at ${target!.addr ?? "local socket"}:${target!.port ?? "-"}`;
}
