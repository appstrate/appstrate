#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * 0035 — READ-ONLY pre-flight, run BEFORE deploying #1641 finding 5/6:
 *
 *   DATABASE_URL=<platform> bun scripts/migration/0035-verify-manifest-expressions.ts
 *
 * `integrationManifestSchema` now refuses every template or runtime expression the platform
 * does not evaluate — `{$outputs.*}` or any other non-`{$credential.<field>}` expression in
 * delivery / `authorized_uris`, the `{{field}}` form in `delivery.http.value` (it used to render
 * there), `{$…}` in a login request, a bare-name jwt `token`, a regex `source` other than
 * `$response.body` / `$response.header.<name>`. It runs on every read of a stored manifest, so a
 * draft or published version holding one fails every connect and run. Prints each such issue
 * (other issues are labelled pre-existing) and exits 1 while any remains. Fix a draft by editing
 * it; publish a fixed version for a published one (its ZIP carries an integrity hash).
 */

import { SQL } from "bun";
import { integrationManifestSchema } from "@appstrate/core/integration";

/** The hint `integrationManifestSchema` appends to every unevaluable-expression issue. */
const EXPRESSION_HINT = " — the platform does not evaluate it (AFPS §7.6/§7.7)";

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

let expressionIssues = 0;
for (const row of rows) {
  const parsed = integrationManifestSchema.safeParse(row.manifest && JSON.parse(row.manifest));
  for (const issue of parsed.error?.issues ?? []) {
    const isExpression = issue.message.endsWith(EXPRESSION_HINT);
    if (isExpression) expressionIssues += 1;
    const at = issue.path.map(String).join(".") || "(root)";
    process.stdout.write(
      `${row.id}@${row.version} ${isExpression ? "EXPRESSION" : "pre-existing"} ${at}: ${issue.message}\n`,
    );
  }
}
process.stdout.write(
  `\n${rows.length} manifest(s) scanned, ${expressionIssues} expression issue(s)\n`,
);
process.exit(expressionIssues > 0 ? 1 : 0);
