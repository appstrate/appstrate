#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * 0024 — pre-flight: stored integration manifests whose JSONPaths the release
 * refuses. READ-ONLY.
 *
 *   DATABASE_URL=<platform> bun scripts/migration/0024-verify-integration-jsonpaths.ts
 *
 * Run BEFORE deploying the release that makes `integrationManifestSchema` parse
 * every manifest JSONPath with `@appstrate/afps-shared/jsonpath` (#1529).
 *
 * Why this exists: that schema is re-applied on every READ of a stored manifest
 * (`apps/api/src/services/integration-service.ts`), not only on import. On the
 * previous release, `identity_claims` were read by a dot-split walk and
 * `connect.login` selectors by the login engine's own tokenizer, both lenient:
 * `$.x-auth-token`, `$.data.0`, `$.data[00]` and a bare `sub` all worked. After
 * the deploy, an integration whose draft or published version holds one fails
 * every connect and run with `invalid_manifest`. There is no lenient read path
 * (docs/NO_TRANSITIONAL_CODE.md) and a published version cannot be rewritten
 * (its ZIP artifact carries an integrity hash), so the fix is the author's: edit
 * the draft, and publish a fixed version for each published one in use.
 *
 * What it reads: `packages.draft_manifest` of every `type = 'integration'` row
 * and `package_versions.manifest` of every version of those packages, parsed
 * with the REAL `integrationManifestSchema`. It prints, per manifest, each
 * JSONPath issue with the equivalent valid rewrite (what the previous reader
 * evaluated, in the new grammar), and separately each other issue, labelled
 * pre-existing. A manifest whose other issues stop the schema before its
 * refinements run shows only those: it was already unreadable.
 *
 * Exit code: 1 when any JSONPath issue is found — the deploy waits until this
 * prints 0 — else 0. Rows: UNMEASURED against production at the time of writing.
 */

import { SQL } from "bun";
import { integrationManifestSchema } from "@appstrate/core/integration";
import { parseJsonPath } from "@appstrate/afps-shared/jsonpath";

/** The hint `integrationManifestSchema` (1f) appends to every JSONPath issue. */
const JSONPATH_ISSUE_SUFFIX = " — supported: $, .name, ['name'], [0], [-1]";

type Segment = { name: string } | { index: number; fromDot?: true };

export interface JsonPathFinding {
  at: string;
  value: string;
  message: string;
  /** The same selection in the new grammar, or null when the old reader refused it too. */
  rewrite: string | null;
  /** Set when a digit dot-segment was read as an array index. */
  note?: string;
}

export interface ManifestReport {
  jsonpath: JsonPathFinding[];
  other: string[];
}

const DIGITS = /^(0|[1-9]\d*)$/;
const DIGIT_NOTE =
  "a digit segment is written as an index — use ['<n>'] if it names an object member";

/** A dot member the old readers took literally; a canonical number becomes an index. */
const dotMember = (key: string): Segment =>
  DIGITS.test(key) ? { index: Number(key), fromDot: true } : { name: key };

/** `identity_claims` on the previous release: optional `$.`, then a dot-split walk. */
function identityClaimSegments(accessor: string): Segment[] {
  const path = accessor.startsWith("$.") ? accessor.slice(2) : accessor;
  return path.split(".").map(dotMember);
}

/** The previous login engine's tokenizer; null where it threw `invalid_config`. */
function loginEngineSegments(path: string): Segment[] | null {
  if (path === "$" || path === "") return [];
  if (!path.startsWith("$")) return null;
  const segments: Segment[] = [];
  let i = 1;
  while (i < path.length) {
    if (path[i] === ".") {
      let end = ++i;
      while (end < path.length && path[end] !== "." && path[end] !== "[") end++;
      const key = path.slice(i, end);
      if (key.length === 0 || key === "*") return null;
      segments.push(dotMember(key));
      i = end;
    } else if (path[i] === "[") {
      const close = path.indexOf("]", i);
      if (close === -1) return null;
      const inner = path.slice(i + 1, close).trim();
      if (/^-?\d+$/.test(inner)) segments.push({ index: Number(inner) });
      else if (/^'.*'$|^".*"$/s.test(inner)) segments.push({ name: inner.slice(1, -1) });
      else return null;
      i = close + 1;
    } else return null;
  }
  return segments;
}

const SHORTHAND = /^[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*$/;
const ESCAPES: Record<string, string> = { "\b": "b", "\f": "f", "\n": "n", "\r": "r", "\t": "t" };

function quoteName(name: string): string {
  let body = "";
  for (const ch of name) {
    if (ch === "\\" || ch === "'") body += `\\${ch}`;
    else if (ch.charCodeAt(0) < 0x20) {
      body += `\\${ESCAPES[ch] ?? `u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`}`;
    } else body += ch;
  }
  return `['${body}']`;
}

function serialize(segments: Segment[]): string {
  return (
    "$" +
    segments
      .map((s) =>
        "index" in s ? `[${s.index}]` : SHORTHAND.test(s.name) ? `.${s.name}` : quoteName(s.name),
      )
      .join("")
  );
}

/**
 * Rewrite `value` into the new grammar so it selects what the previous reader
 * of that field selected. Null when that reader refused it too, or when no
 * rewrite parses back to the same segments.
 */
export function rewriteJsonPath(
  value: string,
  field: "identity_claims" | "login",
): { rewrite: string; digitIndex: boolean } | null {
  const segments =
    field === "identity_claims" ? identityClaimSegments(value) : loginEngineSegments(value);
  if (segments === null) return null;
  const rewrite = serialize(segments);
  try {
    const parsed = parseJsonPath(rewrite);
    const expected = segments.map((s) => ("index" in s ? s.index : s.name));
    if (JSON.stringify(parsed) !== JSON.stringify(expected)) return null;
  } catch {
    return null;
  }
  return { rewrite, digitIndex: segments.some((s) => "fromDot" in s) };
}

function valueAt(root: unknown, path: readonly PropertyKey[]): unknown {
  let cur = root;
  for (const key of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[key];
  }
  return cur;
}

/** Split one manifest's schema issues into JSONPath ones (with a rewrite) and the rest. Pure. */
export function classifyManifest(manifest: unknown): ManifestReport {
  const report: ManifestReport = { jsonpath: [], other: [] };
  const parsed = integrationManifestSchema.safeParse(manifest);
  if (parsed.success) return report;
  for (const issue of parsed.error.issues) {
    const at = issue.path.map(String).join(".");
    const value = valueAt(manifest, issue.path);
    if (!issue.message.endsWith(JSONPATH_ISSUE_SUFFIX) || typeof value !== "string") {
      report.other.push(`${at || "(root)"}: ${issue.message}`);
      continue;
    }
    const fixed = rewriteJsonPath(
      value,
      issue.path[2] === "identity_claims" ? "identity_claims" : "login",
    );
    report.jsonpath.push({
      at,
      value,
      message: issue.message.slice(0, -JSONPATH_ISSUE_SUFFIX.length),
      rewrite: fixed?.rewrite ?? null,
      ...(fixed?.digitIndex ? { note: DIGIT_NOTE } : {}),
    });
  }
  return report;
}

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

interface ManifestRow {
  label: string;
  manifest: string | null;
}

async function main(): Promise<number> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    out("DATABASE_URL is required — the platform database to read");
    return 2;
  }
  const sql = new SQL(url, { max: 1 });
  const rows: ManifestRow[] = await sql.begin(async (tx: SQL) => {
    await tx`SET TRANSACTION READ ONLY`;
    return tx`
      SELECT p.id || ' (draft, org ' || coalesce(p.org_id::text, 'system') || ')' AS label,
             p.draft_manifest::text AS manifest
        FROM packages p
       WHERE p.type = 'integration'
      UNION ALL
      SELECT p.id || '@' || v.version || ' (published, org ' || coalesce(p.org_id::text, 'system') || ')',
             v.manifest::text
        FROM package_versions v
        JOIN packages p ON p.id = v.package_id
       WHERE p.type = 'integration'
       ORDER BY 1`;
  });
  await sql.close();

  let jsonpathManifests = 0;
  let jsonpathIssues = 0;
  let otherManifests = 0;
  for (const row of rows) {
    const report = classifyManifest(row.manifest === null ? null : JSON.parse(row.manifest));
    if (report.jsonpath.length === 0 && report.other.length === 0) continue;
    out(row.label);
    for (const f of report.jsonpath) {
      out(`  JSONPATH ${f.at}: ${JSON.stringify(f.value)} — ${f.message}`);
      out(
        f.rewrite === null
          ? "    no rewrite: the previous reader refused it too"
          : `    rewrite: ${JSON.stringify(f.rewrite)}${f.note ? ` (${f.note})` : ""}`,
      );
    }
    for (const line of report.other) out(`  pre-existing ${line}`);
    if (report.jsonpath.length > 0) jsonpathManifests += 1;
    if (report.other.length > 0) otherManifests += 1;
    jsonpathIssues += report.jsonpath.length;
  }

  out("");
  out(`integration manifests scanned: ${rows.length}`);
  out(`  refused for a JSONPath: ${jsonpathManifests} (${jsonpathIssues} issue(s))`);
  out(`  pre-existing other issues: ${otherManifests}`);
  return jsonpathManifests > 0 ? 1 : 0;
}

// Guarded so the tests can import the pure functions without a database.
if (import.meta.main) {
  process.exit(await main());
}
