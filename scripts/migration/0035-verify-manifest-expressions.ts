#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * 0035 — READ-ONLY pre-flight, run BEFORE deploying #1641:
 *
 *   DATABASE_URL=<platform> bun scripts/migration/0035-verify-manifest-expressions.ts
 *
 * Lists, for every stored integration draft and published version, each expression
 * `integrationManifestSchema` now refuses (`findUnevaluableExpressions`, the manifest stops
 * loading) and each injected credential a run now refuses as `exfiltration`
 * (`findUnboundedInjectedCredentials`); exits 1 while any remains. What it means and how to fix
 * one: `scripts/migration/README.md`.
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
}

export const STORED_MANIFESTS_QUERY = `
  SELECT p.id, 'draft' AS version, p.draft_manifest::text AS manifest
    FROM packages p WHERE p.type = 'integration'
  UNION ALL
  SELECT p.id, v.version, v.manifest::text
    FROM package_versions v JOIN packages p ON p.id = v.package_id
   WHERE p.type = 'integration'
   ORDER BY 1, 2`;

/** One line per issue: `<id>@<version> [expression|exfiltration] <path>: <message>`. */
export function manifestIssues(rows: readonly StoredManifest[]): {
  lines: string[];
  expressions: number;
  exfiltration: number;
} {
  const lines: string[] = [];
  let expressions = 0;
  let exfiltration = 0;
  for (const row of rows) {
    const manifest: unknown = row.manifest && JSON.parse(row.manifest);
    const report = (kind: string, v: { path: readonly PropertyKey[]; message: string }) =>
      lines.push(
        `${row.id}@${row.version} [${kind}] ${v.path.map(String).join(".")}: ${v.message}`,
      );
    for (const v of findUnevaluableExpressions(manifest)) {
      expressions += 1;
      report("expression", v);
    }
    for (const v of findUnboundedInjectedCredentials(manifest)) {
      exfiltration += 1;
      report("exfiltration", v);
    }
  }
  return { lines, expressions, exfiltration };
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

  const { lines, expressions, exfiltration } = manifestIssues(rows);
  for (const line of lines) process.stdout.write(`${line}\n`);
  process.stdout.write(
    `\n${rows.length} manifest(s) scanned, ${expressions} expression issue(s), ` +
      `${exfiltration} injected credential(s) runs will refuse as exfiltration\n`,
  );
  process.exit(lines.length > 0 ? 1 : 0);
}
