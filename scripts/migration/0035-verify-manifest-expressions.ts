#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * 0035 — READ-ONLY pre-flight, run BEFORE deploying #1641:
 *
 *   DATABASE_URL=<platform> bun scripts/migration/0035-verify-manifest-expressions.ts
 *
 * Lists, for every stored integration draft and published version, each expression
 * `integrationManifestSchema` now refuses (`findUnevaluableExpressions`, the manifest stops
 * loading) and each injected credential a run now refuses as `exfiltration` (the
 * `findUnboundedInjectedCredentials` hits `credentialUrlPolicy` refuses). Exits 1 while a draft
 * or a `latest` version (what a run resolves by default) has one; an older version is listed
 * apart, not gated, since only an exact pin reaches it. System packages are skipped: the image
 * ships them (today's `system-packages/` has no issue) and an operator cannot edit one. What it
 * means and how to fix one: `scripts/migration/README.md`.
 */

import { SQL } from "bun";
import {
  findUnboundedInjectedCredentials,
  findUnevaluableExpressions,
} from "@appstrate/core/integration";

export interface StoredManifest {
  id: string;
  version: string;
  manifest: string | null;
  /** A draft, or the version the `latest` dist-tag names. */
  gated: boolean;
}

export const STORED_MANIFESTS_QUERY = `
  SELECT p.id, 'draft' AS version, p.draft_manifest::text AS manifest, true AS gated
    FROM packages p WHERE p.type = 'integration' AND p.source <> 'system'
  UNION ALL
  SELECT p.id, v.version, v.manifest::text,
         EXISTS (SELECT 1 FROM package_dist_tags t WHERE t.version_id = v.id AND t.tag = 'latest')
    FROM package_versions v JOIN packages p ON p.id = v.package_id
   WHERE p.type = 'integration' AND p.source <> 'system'
   ORDER BY 1, 2`;

/**
 * A run refuses an injected credential whose list is empty or names a host-unbounded entry
 * (`credentialUrlPolicy`); `allow_all_uris` beside a list is dropped, the list served.
 */
function refusedAtRun(manifest: unknown, issue: { authKey: string; path: readonly PropertyKey[] }) {
  if (issue.path.at(-1) !== "allow_all_uris") return true;
  const auths = (manifest as { auths: Record<string, { authorized_uris?: unknown }> }).auths;
  const uris = auths[issue.authKey]?.authorized_uris;
  return !Array.isArray(uris) || uris.length === 0;
}

/**
 * One line per issue: `<id>@<version> [expression|exfiltration] <path>: <message>`. `lines` and
 * the counts are the gated rows'; `olderVersions` the rest.
 */
export function manifestIssues(rows: readonly StoredManifest[]): {
  lines: string[];
  olderVersions: string[];
  expressions: number;
  exfiltration: number;
} {
  const lines: string[] = [];
  const olderVersions: string[] = [];
  let expressions = 0;
  let exfiltration = 0;
  for (const row of rows) {
    const manifest: unknown = row.manifest && JSON.parse(row.manifest);
    const out = row.gated ? lines : olderVersions;
    const report = (kind: string, v: { path: readonly PropertyKey[]; message: string }) =>
      out.push(`${row.id}@${row.version} [${kind}] ${v.path.map(String).join(".")}: ${v.message}`);
    for (const v of findUnevaluableExpressions(manifest)) {
      if (row.gated) expressions += 1;
      report("expression", v);
    }
    for (const v of findUnboundedInjectedCredentials(manifest)) {
      if (!refusedAtRun(manifest, v)) continue;
      if (row.gated) exfiltration += 1;
      report("exfiltration", v);
    }
  }
  return { lines, olderVersions, expressions, exfiltration };
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    process.stdout.write("DATABASE_URL is required — the platform database to read\n");
    process.exit(2);
  }
  const sql = new SQL(url, { max: 1 });
  const rows: StoredManifest[] = await sql.begin(async (tx: SQL) => {
    await tx`SET TRANSACTION READ ONLY`;
    return tx.unsafe(STORED_MANIFESTS_QUERY);
  });
  await sql.close();

  const { lines, olderVersions, expressions, exfiltration } = manifestIssues(rows);
  for (const line of lines) process.stdout.write(`${line}\n`);
  if (olderVersions.length > 0) {
    process.stdout.write("\nNot gated — older versions, reached only by an exact pin:\n");
    for (const line of olderVersions) process.stdout.write(`${line}\n`);
  }
  process.stdout.write(
    `\n${rows.length} manifest(s) scanned; drafts and latest versions: ${expressions} expression ` +
      `issue(s), ${exfiltration} injected credential(s) runs will refuse as exfiltration\n`,
  );
  process.exit(lines.length > 0 ? 1 : 0);
}
