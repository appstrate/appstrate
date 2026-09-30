#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * 0035 — READ-ONLY pre-flight, run BEFORE deploying #1641:
 *
 *   DATABASE_URL=<platform> bun scripts/migration/0035-verify-manifest-expressions.ts
 *
 * Lists every stored integration manifest expression `integrationManifestSchema` now refuses
 * (`findUnevaluableExpressions`) and exits 1 while any remains. What it means and how to fix
 * one: `scripts/migration/README.md`.
 */

import { SQL } from "bun";
import { findUnevaluableExpressions } from "@appstrate/core/integration";

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

let issues = 0;
for (const row of rows) {
  for (const v of findUnevaluableExpressions(row.manifest && JSON.parse(row.manifest))) {
    issues += 1;
    process.stdout.write(
      `${row.id}@${row.version} ${v.path.map(String).join(".")}: ${v.message}\n`,
    );
  }
}
process.stdout.write(`\n${rows.length} manifest(s) scanned, ${issues} expression issue(s)\n`);
process.exit(issues > 0 ? 1 : 0);
