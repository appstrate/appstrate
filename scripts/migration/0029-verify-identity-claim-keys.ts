#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * 0029 — READ-ONLY pre-flight, run BEFORE deploying #1545:
 *
 *   DATABASE_URL=<platform> bun scripts/migration/0029-verify-identity-claim-keys.ts
 *
 * `extractIdentity` now keys a connection on the `account_id` identity claim
 * only. An org integration whose draft (what every connect reads) or `latest`
 * published version still declares `identity_claims: { accountId: … }` keys
 * its connections on the `email` / `sub` / "default" fallback after the
 * deploy, so reconnecting or upgrading the scopes of a connection made before
 * it fails 409 `identity_mismatch`. Prints each non-snake_case key
 * (`findNonSnakeCaseIdentityClaimKeys`, the write-path rule) and exits 1
 * while any remains. Fix a draft by editing it; publish a fixed version for a
 * published one (its ZIP carries an integrity hash). Forking a legacy
 * published version is not gated (it reads leniently), so the fork's draft
 * carries the old keys and is flagged here like any other draft.
 *
 * System packages are skipped: connects read them from the boot registry,
 * whose manifests this release fixes (patch-bumped, so the boot sync rewrites
 * their rows) and the `identity-claim-keys` conformance check keeps fixed.
 */

import { SQL } from "bun";
import { findNonSnakeCaseIdentityClaimKeys } from "@appstrate/core/integration";

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
        FROM packages p WHERE p.type = 'integration' AND p.source <> 'system'
      UNION ALL
      SELECT p.id, v.version, v.manifest::text
        FROM package_dist_tags t
        JOIN package_versions v ON v.id = t.version_id
        JOIN packages p ON p.id = t.package_id
       WHERE t.tag = 'latest' AND p.type = 'integration' AND p.source <> 'system'
       ORDER BY 1, 2`;
  },
);
await sql.close();

let offenders = 0;
for (const row of rows) {
  const violations = findNonSnakeCaseIdentityClaimKeys(row.manifest && JSON.parse(row.manifest));
  if (violations.length > 0) offenders += 1;
  for (const v of violations) {
    process.stdout.write(
      `${row.id}@${row.version} ${v.path.map(String).join(".")}: ${v.message}\n`,
    );
  }
}
process.stdout.write(
  `\n${rows.length} manifest(s) scanned, ${offenders} with a non-snake_case identity claim key\n`,
);
process.exit(offenders > 0 ? 1 : 0);
