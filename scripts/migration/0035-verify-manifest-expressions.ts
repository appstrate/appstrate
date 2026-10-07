#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * 0035 — READ-ONLY pre-flight, run BEFORE deploying the release that refuses these expressions:
 *
 *   DATABASE_URL=<platform> bun scripts/migration/0035-verify-manifest-expressions.ts
 *
 * Lists, for every stored integration draft and published version, each expression a connect or
 * a run now refuses (`findUnevaluableExpressions`, the rule of the manifest write paths), each
 * `{{field}}` in a delivery template (delivered as literal text) and each injected credential
 * a run now refuses as `exfiltration` (the `findUnboundedInjectedCredentials` hits
 * `credentialUrlPolicy` refuses). Exits 1 while any of them has one: a range (`^1.0.0`, the agent
 * editor's default) resolves older versions too. System packages are skipped: the image ships them
 * (today's `system-packages/` has no issue) and an operator cannot edit one. What it means and how
 * to fix one: `scripts/migration/README.md`.
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
    FROM packages p WHERE p.type = 'integration' AND p.source <> 'system'
  UNION ALL
  SELECT p.id, v.version, v.manifest::text
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

const DOUBLE_BRACE_PLACEHOLDER = /\{\{[^{}]*\}\}/g;

interface Issue {
  path: readonly PropertyKey[];
  message: string;
}

/** `{{field}}` under `auths.<key>.delivery`, where only `{$credential.<field>}` renders. */
function literalPlaceholders(node: unknown, path: string[] = []): Issue[] {
  if (typeof node === "string") {
    if (path[0] !== "auths" || path[2] !== "delivery") return [];
    return [...new Set(node.match(DOUBLE_BRACE_PLACEHOLDER))].map((placeholder) => ({
      path,
      message: `'${placeholder}' is delivered as literal text; write {$credential.<field>}`,
    }));
  }
  if (typeof node !== "object" || node === null) return [];
  return Object.entries(node).flatMap(([k, v]) => literalPlaceholders(v, [...path, k]));
}

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
    const report = (kind: string, v: Issue) =>
      lines.push(
        `${row.id}@${row.version} [${kind}] ${v.path.map(String).join(".")}: ${v.message}`,
      );
    for (const v of [...findUnevaluableExpressions(manifest), ...literalPlaceholders(manifest)]) {
      expressions += 1;
      report("expression", v);
    }
    for (const v of findUnboundedInjectedCredentials(manifest)) {
      if (!refusedAtRun(manifest, v)) continue;
      exfiltration += 1;
      report("exfiltration", v);
    }
  }
  return { lines, expressions, exfiltration };
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    process.stderr.write("DATABASE_URL is required — the platform database to read\n");
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
    `\n${rows.length} manifest(s) scanned: ${expressions} expression issue(s), ` +
      `${exfiltration} injected credential(s) runs will refuse as exfiltration\n`,
  );
  process.exit(lines.length > 0 ? 1 : 0);
}
