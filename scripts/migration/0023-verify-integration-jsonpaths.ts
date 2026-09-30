#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * 0023 — READ-ONLY pre-flight, run BEFORE deploying #1529:
 *
 *   DATABASE_URL=<platform> bun scripts/migration/0023-verify-integration-jsonpaths.ts
 *
 * `integrationManifestSchema` now parses manifest JSONPaths strictly, and it
 * runs on every read of a stored manifest, so a draft or published version
 * holding a form the old lenient readers accepted fails every connect and run.
 * Prints each such issue (other issues are labelled pre-existing) and exits 1
 * while any remains. Fix a draft by editing it; publish a fixed version for a
 * published one (its ZIP carries an integrity hash).
 */

import { SQL } from "bun";
import { integrationManifestSchema } from "@appstrate/core/integration";

/** The hint `integrationManifestSchema` appends to every JSONPath issue. */
const JSONPATH_HINT = " — supported: $, .name, ['name'], [0], [-1]";

const url = process.env.DATABASE_URL;
if (!url) {
  process.stdout.write("DATABASE_URL is required — the platform database to read\n");
  process.exit(2);
}
const sql = new SQL(url, { max: 1 });
const rows: { id: string; version: string; manifest: string | null }[] = await sql.begin(
  async (tx: SQL) => {
    await tx`SET TRANSACTION READ ONLY`;
    return tx`
      SELECT p.id, 'draft' AS version, p.draft_manifest::text AS manifest
        FROM packages p WHERE p.type = 'integration'
      UNION ALL
      SELECT p.id, v.version, v.manifest::text
        FROM package_versions v JOIN packages p ON p.id = v.package_id
       WHERE p.type = 'integration'
       ORDER BY 1, 2`;
  },
);
await sql.close();

let jsonpathIssues = 0;
for (const row of rows) {
  const parsed = integrationManifestSchema.safeParse(row.manifest && JSON.parse(row.manifest));
  for (const issue of parsed.error?.issues ?? []) {
    const isJsonPath = issue.message.endsWith(JSONPATH_HINT);
    if (isJsonPath) jsonpathIssues += 1;
    const at = issue.path.map(String).join(".") || "(root)";
    process.stdout.write(
      `${row.id}@${row.version} ${isJsonPath ? "JSONPATH" : "pre-existing"} ${at}: ${issue.message}\n`,
    );
  }
}
process.stdout.write(`\n${rows.length} manifest(s) scanned, ${jsonpathIssues} JSONPath issue(s)\n`);
process.exit(jsonpathIssues > 0 ? 1 : 0);
