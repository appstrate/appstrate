// SPDX-License-Identifier: Apache-2.0

/**
 * The database a script of `scripts/migration/` targets: `DATABASE_URL`, or an embedded database
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
