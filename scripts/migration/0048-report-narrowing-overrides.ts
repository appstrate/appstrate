#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * 0048 — READ-ONLY report (#2043), before deploying the release where a launch override can no
 * longer NARROW a connection set an admin imposes:
 *
 *   DATABASE_URL=<platform> bun scripts/migration/0048-report-narrowing-overrides.ts
 *
 * Under an admin pin (`integration_pins.user_id IS NULL` for the schedule's space, agent and
 * integration) or, without one, an enforced org default (`integration_org_defaults.enforce` for
 * its space and integration), a launch override naming `[]` or a strict subset of the imposed set
 * used to bind just that subset. After the deploy the whole imposed set binds: the bound set of
 * every schedule listed here WIDENS at its next fire. Lists those schedules (enabled or not) with
 * the override, the imposed set and the layer imposing it, then counts them. An override naming an
 * id outside the imposed set was never a narrowing and is not listed. Runs are not reported: a
 * stored run's `connection_overrides` are history, and `rerun_from` replays the stored input only.
 * Nothing is rewritten. One READ ONLY transaction.
 */

import { SQL } from "bun";
import { table } from "./lib/report-table.ts";

interface NarrowingScheduleRow {
  org: string;
  space: string;
  id: string;
  name: string | null;
  enabled: boolean;
  package_id: string;
  integration: string;
  override_set: string;
  imposed_set: string;
  imposed_by: string;
}

export interface ReportSnapshot {
  schedules: NarrowingScheduleRow[];
}

/**
 * Every (owner, integration) entry of `package_schedules.connection_overrides` whose set is `[]` or a strict
 * subset of the set imposed on that integration, as `narrowed`. Sets are compared as lowercase,
 * deduplicated, ordered `text[]`, so case and order never matter. `jsonb_each` raises on anything
 * but an object and `jsonb_array_elements_text` on anything but an array: a CASE (unlike an AND,
 * which the planner may reorder) evaluates the type test first, so a malformed row is skipped
 * instead of aborting the report. Layer precedence is the resolver's: the admin pin, else the
 * enforced org default; an empty imposed set (a pin to no connection) narrows nothing.
 */
const narrowed = () => `
  WITH entries AS (
    SELECT o.id::text AS owner_id, o.space_id, o.package_id, e.key AS integration,
           ARRAY(SELECT DISTINCT lower(x) AS v
                   FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(e.value) = 'array'
                                                       THEN e.value ELSE '[]'::jsonb END) x
                  ORDER BY v) AS override_ids
      FROM package_schedules o
     CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(o.connection_overrides) = 'object'
                                        THEN o.connection_overrides ELSE '{}'::jsonb END) e
     WHERE jsonb_typeof(e.value) = 'array'
  ), imposed AS (
    SELECT en.*,
           CASE WHEN p.id IS NOT NULL THEN 'admin pin'
                WHEN d.id IS NOT NULL THEN 'enforced org default' END AS imposed_by,
           ARRAY(SELECT DISTINCT lower(x::text) AS v
                   FROM unnest(COALESCE(p.connection_ids, d.connection_ids)) x
                  ORDER BY v) AS imposed_ids
      FROM entries en
      LEFT JOIN integration_pins p
             ON p.space_id = en.space_id AND p.package_id = en.package_id
            AND p.integration_package_id = en.integration AND p.user_id IS NULL
      LEFT JOIN integration_org_defaults d
             ON d.space_id = en.space_id AND d.integration_package_id = en.integration
            AND d.enforce
  ), narrowed AS (
    SELECT * FROM imposed
     WHERE imposed_by IS NOT NULL
       AND cardinality(imposed_ids) > 0
       AND override_ids <@ imposed_ids
       AND cardinality(override_ids) < cardinality(imposed_ids)
  )`;

const SCHEDULES_QUERY = `${narrowed()}
  SELECT o.slug AS org, s.name AS space, sc.id, sc.name, sc.enabled, sc.package_id,
         n.integration,
         '[' || array_to_string(n.override_ids, ', ') || ']' AS override_set,
         '[' || array_to_string(n.imposed_ids, ', ') || ']' AS imposed_set,
         n.imposed_by
    FROM narrowed n
    JOIN package_schedules sc ON sc.id = n.owner_id
    JOIN organizations o ON o.id = sc.org_id
    JOIN spaces s ON s.id = sc.space_id
   ORDER BY 1, 2, 6, 3, 7`;

export async function readSnapshot(
  run: (query: string) => Promise<unknown[]>,
): Promise<ReportSnapshot> {
  return { schedules: (await run(SCHEDULES_QUERY)) as NarrowingScheduleRow[] };
}

export function report({ schedules }: ReportSnapshot): string[] {
  if (schedules.length === 0) return ["0 schedules — nothing widens."];
  const ids = new Set(schedules.map((s) => s.id));
  const enabled = new Set(schedules.filter((s) => s.enabled).map((s) => s.id)).size;
  return [
    ...table(
      [
        "org",
        "space",
        "schedule",
        "name",
        "enabled",
        "agent",
        "integration",
        "override",
        "imposed",
        "imposed by",
      ],
      schedules.map((s) => [
        s.org,
        s.space,
        s.id,
        s.name ?? "",
        s.enabled ? "yes" : "no",
        s.package_id,
        s.integration,
        s.override_set,
        s.imposed_set,
        s.imposed_by,
      ]),
    ),
    "",
    `${ids.size} schedule(s) widen at their next fire: ${enabled} enabled, ` +
      `${ids.size - enabled} disabled (${schedules.length} integration entr` +
      `${schedules.length === 1 ? "y" : "ies"}).`,
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
