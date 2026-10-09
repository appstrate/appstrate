#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * 0040 — READ-ONLY report (#1846), before deploying the release where a run's `token_usage` is
 * published as the strict `TokenUsage` component:
 *
 *   DATABASE_URL=<platform> bun scripts/migration/0040-report-token-usage-shape.ts
 *
 * Lists every run whose stored `token_usage` breaks the rule `parseTokenUsage` applies on
 * ingestion: not an object (a JSON `null` included), a key outside the five declared ones, a
 * counter that is not a non-negative safe integer, or `tiers` failing `isTokenUsageTiers`. Such a
 * row is returned verbatim by the run read paths, so a client validating against the spec rejects
 * it. Expected 0; anything else is a row to repair. One READ ONLY transaction.
 */

import { SQL } from "bun";
import {
  isTokenCount,
  isTokenUsageTiers,
  TOKEN_USAGE_COUNTERS,
} from "@appstrate/afps-shared/token-usage";

interface RunUsageRow {
  org: string;
  id: string;
  token_usage: string;
}

export interface ReportSnapshot {
  runs: RunUsageRow[];
}

const PROBLEMS = ["not_object", "unknown_keys", "bad_counters", "bad_tiers"] as const;
type Problem = (typeof PROBLEMS)[number];

const DECLARED_KEYS = new Set<string>([...TOKEN_USAGE_COUNTERS, "tiers"]);

const RUN_USAGE_QUERY = `
  SELECT o.slug AS org, r.id, r.token_usage::text AS token_usage
    FROM runs r
    JOIN organizations o ON o.id = r.org_id
   WHERE r.token_usage IS NOT NULL
   ORDER BY 1, 2`;

export async function readSnapshot(
  run: (query: string) => Promise<unknown[]>,
): Promise<ReportSnapshot> {
  return { runs: (await run(RUN_USAGE_QUERY)) as RunUsageRow[] };
}

function problemsOf(value: unknown): Problem[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return ["not_object"];
  const usage = value as Record<string, unknown>;
  const found: Problem[] = [];
  if (Object.keys(usage).some((key) => !DECLARED_KEYS.has(key))) found.push("unknown_keys");
  if (TOKEN_USAGE_COUNTERS.some((c) => usage[c] !== undefined && !isTokenCount(usage[c]))) {
    found.push("bad_counters");
  }
  if (usage.tiers !== undefined && !isTokenUsageTiers(usage.tiers)) found.push("bad_tiers");
  return found;
}

/** One line per run breaking the rule — `<org> <run>: <problems>` — then the totals. */
export function report({ runs }: ReportSnapshot): string[] {
  const flagged = runs
    .map((r) => ({ ...r, problems: problemsOf(JSON.parse(r.token_usage)) }))
    .filter((r) => r.problems.length > 0);
  const counts = PROBLEMS.map(
    (problem) => `${flagged.filter((r) => r.problems.includes(problem)).length} ${problem}`,
  );
  return [
    ...flagged.map((r) => `${r.org} ${r.id}: ${r.problems.join(", ")}`),
    `${flagged.length} of ${runs.length} run(s) with a token_usage break the rule (expected 0): ` +
      `${counts.join(", ")}.`,
  ];
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    process.stderr.write("DATABASE_URL is required — the platform database to read\n");
    process.exit(2);
  }
  const sql = new SQL(url, { max: 1 });
  const snapshot = await sql.begin(async (tx: SQL) => {
    await tx`SET TRANSACTION READ ONLY`;
    return readSnapshot((query) => tx.unsafe(query));
  });
  await sql.close();
  process.stdout.write(`${report(snapshot).join("\n")}\n`);
  process.exit(0);
}
