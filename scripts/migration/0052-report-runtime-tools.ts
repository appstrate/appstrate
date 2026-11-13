#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * 0052 — READ-ONLY report (#2197, #2199), before running `0053-migrate-runtime-tools.sql`, which
 * moves every stored agent manifest from `runtime_tools` to the `@appstrate/platform`
 * integration:
 *
 *   DATABASE_URL=<platform> bun scripts/migration/0052-report-runtime-tools.ts
 *
 * Reads `packages.draft_manifest` and `package_versions.manifest` and prints:
 *
 *   - the agent manifests `0053` rewrites (they carry `runtime_tools` or do not declare
 *     `@appstrate/platform`), and the malformed ones it leaves untouched (`dependencies`,
 *     `dependencies.integrations`, `integrations_configuration` or
 *     `integrations_configuration."@appstrate/platform"` present but not an object);
 *   - the agents that list `"output"` in `runtime_tools` without a non-empty `output.schema`:
 *     they have no `output` tool after the deploy. Listed per agent, with its runs of the last
 *     90 days and how many of them stored a `result.output`, which is the measure of whether the
 *     free-form result is actually used. Manifests WITH a schema keep `output` (injected from
 *     the schema) and are counted, not listed.
 *
 * Ephemeral packages (inline runs) are flagged: inline runs receive an open object schema by
 * default and keep `output`. Nothing is rewritten. One READ ONLY transaction.
 */

import { SQL } from "bun";
import { table } from "./lib/report-table.ts";

interface AffectedAgentRow {
  org: string;
  package_id: string;
  ephemeral: boolean;
  in_draft: boolean;
  versions: string;
  runs_90d: number;
  runs_with_output_90d: number;
}

interface CountsRow {
  drafts_to_rewrite: number;
  versions_to_rewrite: number;
  drafts_malformed: number;
  versions_malformed: number;
  drafts_with_output: number;
  versions_with_output: number;
  drafts_without_schema: number;
  versions_without_schema: number;
}

export interface ReportSnapshot {
  affected: AffectedAgentRow[];
  counts: CountsRow;
}

/**
 * `SELECTS_OUTPUT(m)` is true when `m.runtime_tools` is an array containing `"output"`;
 * `HAS_SCHEMA(m)` when `m.output.schema` is a non-empty object — the condition under which the
 * runner injects `output` (`readDeclaredOutputSchema`). A CASE evaluates the type test before the containment, so a
 * malformed manifest is skipped instead of aborting the report.
 */
const SELECTS_OUTPUT = (m: string) =>
  `(CASE WHEN jsonb_typeof(${m}->'runtime_tools') = 'array'
         THEN ${m}->'runtime_tools' @> '["output"]'::jsonb ELSE false END)`;
const HAS_SCHEMA = (m: string) =>
  `(CASE WHEN jsonb_typeof(${m}->'output'->'schema') = 'object'
         THEN ${m}->'output'->'schema' <> '{}'::jsonb ELSE false END)`;

/**
 * `IS_AGENT_TO_MIGRATE(m)` is `0053`'s condition minus the shape checks: an agent manifest that
 * carries `runtime_tools` or does not declare `@appstrate/platform`. `WELL_FORMED(m)` is the shape
 * check `0053` applies before rewriting.
 */
const IS_AGENT_TO_MIGRATE = (m: string) =>
  `(${m}->>'type' = 'agent'
    AND (${m}->'runtime_tools' IS NOT NULL
         OR ${m}->'dependencies'->'integrations'->'@appstrate/platform' IS NULL))`;
const WELL_FORMED = (m: string) =>
  `(jsonb_typeof(COALESCE(${m}->'dependencies', '{}'::jsonb)) = 'object'
    AND jsonb_typeof(COALESCE(${m}->'dependencies'->'integrations', '{}'::jsonb)) = 'object'
    AND jsonb_typeof(COALESCE(${m}->'integrations_configuration', '{}'::jsonb)) = 'object'
    AND jsonb_typeof(COALESCE(${m}->'integrations_configuration'->'@appstrate/platform', '{}'::jsonb)) = 'object')`;

const AFFECTED_QUERY = `
  WITH drafts AS (
    SELECT p.id AS package_id
      FROM packages p
     WHERE p.type = 'agent'
       AND ${SELECTS_OUTPUT("p.draft_manifest")} AND NOT ${HAS_SCHEMA("p.draft_manifest")}
  ), versions AS (
    SELECT v.package_id, string_agg(v.version, ', ' ORDER BY v.created_at) AS versions
      FROM package_versions v
     WHERE ${SELECTS_OUTPUT("v.manifest")} AND NOT ${HAS_SCHEMA("v.manifest")}
     GROUP BY v.package_id
  ), ids AS (
    SELECT package_id FROM drafts UNION SELECT package_id FROM versions
  )
  SELECT COALESCE(o.slug, '(system)') AS org, p.id AS package_id, p.ephemeral,
         (d.package_id IS NOT NULL) AS in_draft,
         COALESCE(ver.versions, '') AS versions,
         (SELECT count(*)::int FROM runs r
           WHERE r.package_id = p.id AND r.started_at > now() - interval '90 days') AS runs_90d,
         (SELECT count(*)::int FROM runs r
           WHERE r.package_id = p.id AND r.started_at > now() - interval '90 days'
             AND jsonb_typeof(r.result) = 'object' AND r.result->'output' IS NOT NULL) AS runs_with_output_90d
    FROM ids
    JOIN packages p ON p.id = ids.package_id
    LEFT JOIN organizations o ON o.id = p.org_id
    LEFT JOIN drafts d ON d.package_id = p.id
    LEFT JOIN versions ver ON ver.package_id = p.id
   ORDER BY 1, 2`;

const COUNTS_QUERY = `
  SELECT
    (SELECT count(*)::int FROM packages p
      WHERE ${IS_AGENT_TO_MIGRATE("p.draft_manifest")}
        AND ${WELL_FORMED("p.draft_manifest")}) AS drafts_to_rewrite,
    (SELECT count(*)::int FROM package_versions v
      WHERE ${IS_AGENT_TO_MIGRATE("v.manifest")}
        AND ${WELL_FORMED("v.manifest")}) AS versions_to_rewrite,
    (SELECT count(*)::int FROM packages p
      WHERE ${IS_AGENT_TO_MIGRATE("p.draft_manifest")}
        AND NOT ${WELL_FORMED("p.draft_manifest")}) AS drafts_malformed,
    (SELECT count(*)::int FROM package_versions v
      WHERE ${IS_AGENT_TO_MIGRATE("v.manifest")}
        AND NOT ${WELL_FORMED("v.manifest")}) AS versions_malformed,
    (SELECT count(*)::int FROM packages p
      WHERE p.type = 'agent' AND ${SELECTS_OUTPUT("p.draft_manifest")}) AS drafts_with_output,
    (SELECT count(*)::int FROM package_versions v
      WHERE ${SELECTS_OUTPUT("v.manifest")}) AS versions_with_output,
    (SELECT count(*)::int FROM packages p
      WHERE p.type = 'agent' AND ${SELECTS_OUTPUT("p.draft_manifest")}
        AND NOT ${HAS_SCHEMA("p.draft_manifest")}) AS drafts_without_schema,
    (SELECT count(*)::int FROM package_versions v
      WHERE ${SELECTS_OUTPUT("v.manifest")}
        AND NOT ${HAS_SCHEMA("v.manifest")}) AS versions_without_schema`;

export async function readSnapshot(
  run: (query: string) => Promise<unknown[]>,
): Promise<ReportSnapshot> {
  const affected = (await run(AFFECTED_QUERY)) as AffectedAgentRow[];
  const [counts] = (await run(COUNTS_QUERY)) as CountsRow[];
  return { affected, counts: counts! };
}

export function report({ affected, counts }: ReportSnapshot): string[] {
  const lines = [
    `to_rewrite (0053): ${counts.drafts_to_rewrite} draft manifest(s), ` +
      `${counts.versions_to_rewrite} published version manifest(s).`,
    `malformed, left untouched: ${counts.drafts_malformed} draft(s), ` +
      `${counts.versions_malformed} version(s).`,
    `runtime_tools lists "output": ${counts.drafts_with_output} draft manifest(s), ` +
      `${counts.versions_with_output} published version manifest(s).`,
    `…of which without output.schema: ${counts.drafts_without_schema} draft(s), ` +
      `${counts.versions_without_schema} version(s).`,
    "",
  ];
  if (affected.length === 0) return [...lines, "0 agents lose the output tool."];
  const using = affected.filter((a) => a.runs_with_output_90d > 0).length;
  return [
    ...lines,
    ...table(
      ["org", "agent", "ephemeral", "draft", "versions", "runs 90d", "runs with output 90d"],
      affected.map((a) => [
        a.org,
        a.package_id,
        a.ephemeral ? "yes" : "no",
        a.in_draft ? "yes" : "no",
        a.versions,
        String(a.runs_90d),
        String(a.runs_with_output_90d),
      ]),
    ),
    "",
    `${affected.length} agent(s) select "output" without an output schema; ` +
      `${using} of them stored a result.output in the last 90 days.`,
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
