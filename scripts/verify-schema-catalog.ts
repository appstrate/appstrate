// SPDX-License-Identifier: Apache-2.0

/**
 * Compare a database's schema catalog against the committed fingerprint of the
 * schema the migration chain builds (`packages/db/schema-catalog.txt`).
 *
 * `scripts/schema-catalog.sql` states what the fingerprint covers and why; this
 * script only runs it against `DATABASE_URL` and diffs the result.
 *
 *   bun run verify:schema-catalog            # diff DATABASE_URL against the fingerprint
 *   bun run verify:schema-catalog --write    # rewrite the fingerprint FROM DATABASE_URL
 *
 * CI (`.github/workflows/check.yml`, job `schema-catalog`) runs the first form
 * on a database it has just built with `bun packages/db/src/migrate.ts`, so a
 * migration that changes the schema without regenerating the fingerprint fails
 * there. Regenerate it the same way: migrate an EMPTY Postgres 16 database, then
 * `--write` against it — never against a long-lived one, whose drift would be
 * committed as the reference.
 */

import { SQL } from "bun";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const QUERY = resolve(ROOT, "scripts/schema-catalog.sql");
const FINGERPRINT = resolve(ROOT, "packages/db/schema-catalog.txt");

const url = process.env["DATABASE_URL"];
if (!url) {
  console.error("verify-schema-catalog: DATABASE_URL is required (a Postgres 16 database)");
  process.exit(2);
}

const sql = new SQL(url);
const rows: { line: string }[] = await sql.unsafe(await Bun.file(QUERY).text());
const version: { server_version: string }[] = await sql.unsafe("SHOW server_version");
await sql.close();

const major = version[0]?.server_version.split(".")[0];
if (major !== "16") {
  console.error(
    `verify-schema-catalog: the server is Postgres ${version[0]?.server_version}; the fingerprint is Postgres 16's formatting`,
  );
  process.exit(2);
}

const actual = rows.map((r) => r.line);

if (process.argv.includes("--write")) {
  await Bun.write(FINGERPRINT, actual.join("\n") + "\n");
  console.log(
    `verify-schema-catalog: wrote ${actual.length} lines to packages/db/schema-catalog.txt`,
  );
  process.exit(0);
}

const expected = (await Bun.file(FINGERPRINT).text()).split("\n").filter((l) => l !== "");
const expectedSet = new Set(expected);
const actualSet = new Set(actual);
const missing = expected.filter((l) => !actualSet.has(l));
const extra = actual.filter((l) => !expectedSet.has(l));

if (missing.length === 0 && extra.length === 0) {
  console.log(
    `✓ verify-schema-catalog: ${actual.length} catalog lines identical to packages/db/schema-catalog.txt`,
  );
  process.exit(0);
}

console.error(
  `✗ verify-schema-catalog: the database differs from packages/db/schema-catalog.txt — ${missing.length} line(s) only in the fingerprint, ${extra.length} only in the database`,
);
for (const l of missing) console.error(`  - ${l}`);
for (const l of extra) console.error(`  + ${l}`);
console.error(
  "\nOn a freshly migrated database this means a migration changed the schema: regenerate the fingerprint " +
    "(`bun run verify:schema-catalog --write` against an EMPTY database you just migrated) and commit it.\n" +
    "On a long-lived database (production) it is drift from the chain: see scripts/migration/0018-prod-schema-realign.sql (#1507).",
);
process.exit(1);
