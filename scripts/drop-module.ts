#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * Drop a module's database footprint — tables and migration tracking.
 *
 * Reads the module's `schema.ts` to enumerate owned tables, dumps them to
 * `./data/backups/<moduleId>-<timestamp>.sql` via `pg_dump`, then issues
 * `DROP TABLE … CASCADE` inside a single transaction and drops the module's
 * `__drizzle_migrations_<id>` tracking table.
 *
 * Usage:
 *   bun scripts/drop-module.ts <moduleId>
 *   bun scripts/drop-module.ts webhooks
 *   bun scripts/drop-module.ts webhooks --dry-run
 *
 * Safety:
 *   - Refuses to run without DATABASE_URL set.
 *   - Refuses to run without a successful pg_dump (backup is mandatory).
 *   - Verifies pg_dump and psql are on PATH before touching anything.
 *   - Passes the connection string through PGURL / libpq `service` instead of
 *     argv so the DB password never lands in `ps aux`.
 *   - Wraps all DROPs in a transaction — partial drops are impossible.
 *   - Prompts for confirmation unless --yes is passed.
 *   - `--dry-run` prints the plan without touching the DB or filesystem.
 *
 * Note on crash semantics: if the process is killed mid-`pg_dump`, a truncated
 * `.sql` file may remain in `./data/backups/`. Review the directory after any
 * aborted run before assuming the backup exists.
 */

import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";

const moduleId = process.argv[2];
const autoYes = process.argv.includes("--yes");
const dryRun = process.argv.includes("--dry-run");

if (!moduleId || moduleId.startsWith("-")) {
  console.error("Usage: bun scripts/drop-module.ts <moduleId> [--yes] [--dry-run]");
  process.exit(1);
}

const dbUrl = process.env["DATABASE_URL"];
if (!dbUrl) {
  console.error("DATABASE_URL not set — refusing to run.");
  process.exit(1);
}

// Resolve pg_dump / psql up front so a missing binary fails immediately rather
// than after the user confirms.
function assertBinary(name: string): void {
  const which = spawnSync("which", [name], { stdio: "pipe" });
  if (which.status !== 0) {
    console.error(`${name} not found on PATH — install postgresql-client tools.`);
    process.exit(1);
  }
}
if (!dryRun) {
  assertBinary("pg_dump");
  assertBinary("psql");
}

const moduleDir = resolve(import.meta.dir, "../apps/api/src/modules", moduleId);
const schemaPath = join(moduleDir, "schema.ts");
if (!existsSync(schemaPath)) {
  console.error(`Module schema not found: ${schemaPath}`);
  process.exit(1);
}

// Parse owned tables from `pgTable("<name>", …)` calls. Good enough for the
// codebase convention of literal table names; bails out if zero matches.
const schemaSrc = readFileSync(schemaPath, "utf-8");
const tableMatches = Array.from(schemaSrc.matchAll(/pgTable\(\s*["']([^"']+)["']/g));
const rawTables = Array.from(new Set(tableMatches.map((m) => m[1]!)));

// Whitelist table names to safe SQL identifiers — defends against a schema
// file containing a malformed or injected string sneaking into the DROP SQL.
const SAFE_IDENT = /^[a-z_][a-z0-9_]*$/;
const unsafe = rawTables.filter((t) => !SAFE_IDENT.test(t));
if (unsafe.length > 0) {
  console.error(`Refusing to continue — unsafe table name(s) parsed: ${unsafe.join(", ")}`);
  process.exit(1);
}
const tables = rawTables;

if (tables.length === 0) {
  console.error(`No pgTable() calls found in ${schemaPath}`);
  process.exit(1);
}

const migrationsTable = `__drizzle_migrations_${moduleId.replace(/-/g, "_")}`;
if (!SAFE_IDENT.test(migrationsTable)) {
  // Defensive — moduleId contains something other than [a-z0-9-].
  console.error(`Unsafe migration tracking table name: ${migrationsTable}`);
  process.exit(1);
}

console.log(`Module: ${moduleId}`);
console.log(`Tables to drop: ${tables.join(", ")}`);
console.log(`Migration tracking table: ${migrationsTable}`);

if (dryRun) {
  const dropSql =
    tables.map((t) => `  DROP TABLE IF EXISTS "${t}" CASCADE;`).join("\n") +
    `\n  DROP TABLE IF EXISTS "${migrationsTable}" CASCADE;`;
  console.log("\n[dry-run] SQL that would execute:");
  console.log("BEGIN;");
  console.log(dropSql);
  console.log("COMMIT;");
  process.exit(0);
}

if (!autoYes) {
  process.stdout.write("\nProceed with backup + drop? [y/N] ");
  const answer = await new Promise<string>((r) => {
    process.stdin.once("data", (d) => r(String(d).trim().toLowerCase()));
  });
  if (answer !== "y" && answer !== "yes") {
    console.log("Aborted.");
    process.exit(0);
  }
}

// Parse the URL into libpq env vars so the password never lands in argv
// (visible in `ps aux` on multi-user hosts).
let parsedUrl: URL;
try {
  parsedUrl = new URL(dbUrl);
} catch {
  console.error("DATABASE_URL is not a valid URL.");
  process.exit(1);
}
const childEnv: Record<string, string> = { ...process.env } as Record<string, string>;
childEnv.PGHOST = parsedUrl.hostname;
if (parsedUrl.port) childEnv.PGPORT = parsedUrl.port;
if (parsedUrl.username) childEnv.PGUSER = decodeURIComponent(parsedUrl.username);
if (parsedUrl.password) childEnv.PGPASSWORD = decodeURIComponent(parsedUrl.password);
const dbName = parsedUrl.pathname.replace(/^\//, "");
if (dbName) childEnv.PGDATABASE = dbName;
// Remove DATABASE_URL from the child env so the URL (with password) is not
// propagated further through process spawning.
delete childEnv.DATABASE_URL;

// 1. Backup via pg_dump — include both schema and data so the dump can be
// restored into an empty database if recovery is ever needed.
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupDir = resolve(import.meta.dir, "../data/backups");
mkdirSync(backupDir, { recursive: true });
const backupPath = join(backupDir, `${moduleId}-${timestamp}.sql`);

console.log(`\nBacking up to ${backupPath} …`);
const pgDumpArgs = ["--no-owner", "--no-acl"];
for (const table of tables) pgDumpArgs.push("-t", `public.${table}`);
pgDumpArgs.push("-f", backupPath);
const dump = spawnSync("pg_dump", pgDumpArgs, { stdio: "inherit", env: childEnv });
if (dump.error || dump.status === null || dump.status !== 0) {
  console.error(`pg_dump failed — refusing to drop. ${dump.error?.message ?? ""}`);
  process.exit(1);
}

// 2. Drop tables + migration tracking inside a transaction so a failure
// halfway through doesn't leave the database in a half-dropped state.
console.log("\nDropping tables …");
const dropSql =
  `BEGIN;\n` +
  tables.map((t) => `DROP TABLE IF EXISTS "${t}" CASCADE;`).join("\n") +
  `\nDROP TABLE IF EXISTS "${migrationsTable}" CASCADE;\n` +
  `COMMIT;\n`;

const psql = spawnSync("psql", ["-v", "ON_ERROR_STOP=1", "-c", dropSql], {
  stdio: "inherit",
  env: childEnv,
});
if (psql.error || psql.status === null || psql.status !== 0) {
  console.error(
    `psql DROP failed — see output. Backup preserved at: ${backupPath}. ${psql.error?.message ?? ""}`,
  );
  process.exit(1);
}

console.log(`\n✓ Module "${moduleId}" dropped. Backup: ${backupPath}`);
console.log(`  Next: remove "${moduleId}" from MODULES and restart.`);
