#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * 0039 — READ-ONLY report (#1830), before deploying the release where a declared integration is
 * optional unless the agent marks it `required`:
 *
 *   DATABASE_URL=<platform> bun scripts/migration/0039-report-integration-deps.ts
 *
 * Lists, per organization and home space, every agent (draft and `latest` published version)
 * declaring integrations, with each one's `integrations_configuration.<id>.required`, then every
 * ENABLED schedule firing such an agent (`version_override` included). An integration printed
 * `optional` used to refuse a run with no usable connection; after the deploy that run starts
 * without it. Writes nothing (one READ ONLY transaction); exits 0, 2 without `DATABASE_URL`.
 */

import { SQL } from "bun";
import { parseManifestIntegrations } from "@appstrate/core/dependencies";

interface AgentManifestRow {
  org: string;
  space: string;
  id: string;
  version: string;
  manifest: string | null;
}

interface ScheduleRow {
  org: string;
  space: string;
  id: string;
  name: string | null;
  package_id: string;
  version_override: string | null;
  connection_overrides: string | null;
}

const AGENT_MANIFESTS_QUERY = `
  SELECT o.slug AS org, s.name AS space, p.id, 'draft' AS version,
         p.draft_manifest::text AS manifest
    FROM packages p
    JOIN organizations o ON o.id = p.org_id
    JOIN spaces s ON s.id = p.home_space_id
   WHERE p.type = 'agent' AND NOT p.ephemeral
  UNION ALL
  SELECT o.slug, s.name, p.id, v.version, v.manifest::text
    FROM packages p
    JOIN organizations o ON o.id = p.org_id
    JOIN spaces s ON s.id = p.home_space_id
    JOIN package_dist_tags t ON t.package_id = p.id AND t.tag = 'latest'
    JOIN package_versions v ON v.id = t.version_id
   WHERE p.type = 'agent' AND NOT p.ephemeral
   ORDER BY 1, 2, 3, 4`;

const ENABLED_SCHEDULES_QUERY = `
  SELECT o.slug AS org, s.name AS space, sc.id, sc.name, sc.package_id,
         sc.version_override, sc.connection_overrides::text AS connection_overrides
    FROM package_schedules sc
    JOIN organizations o ON o.id = sc.org_id
    JOIN spaces s ON s.id = sc.space_id
   WHERE sc.enabled
   ORDER BY 1, 2, 5, 3`;

/** `<id>` (required) or `<id>` (optional), per declared integration; empty when none. */
function integrationsOf(manifest: string | null): string[] {
  if (!manifest) return [];
  const parsed: unknown = JSON.parse(manifest);
  if (!parsed || typeof parsed !== "object") return [];
  return parseManifestIntegrations(parsed as Record<string, unknown>).map(
    (entry) => `${entry.id} (${entry.required === true ? "required" : "optional"})`,
  );
}

/** Padded columns, one line per row, a header and a rule. */
function table(header: string[], rows: string[][]): string[] {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => c.padEnd(widths[i]!))
      .join("  ")
      .trimEnd();
  return [line(header), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(line)];
}

/** The report's lines: the agents declaring integrations, then the enabled schedules firing one. */
function report(agents: readonly AgentManifestRow[], schedules: readonly ScheduleRow[]) {
  const agentRows = agents.flatMap((a) =>
    integrationsOf(a.manifest).map((integration) => [a.org, a.space, a.id, a.version, integration]),
  );
  const declaring = new Set(agentRows.map((row) => row[2]!));
  const optional = agentRows.filter((row) => row[4]!.endsWith("(optional)")).length;
  const scheduleRows = schedules
    .filter((s) => declaring.has(s.package_id))
    .map((s) => [
      s.org,
      s.space,
      s.package_id,
      s.id,
      s.name ?? "",
      s.version_override ?? "(default)",
      s.connection_overrides ?? "",
    ]);
  return [
    ...table(["org", "home space", "agent", "version", "integration"], agentRows),
    "",
    ...table(
      ["org", "space", "agent", "schedule", "name", "version_override", "connection_overrides"],
      scheduleRows,
    ),
    "",
    `${declaring.size} agent(s) declare integrations: ${agentRows.length} declaration(s), ` +
      `${optional} optional; ${scheduleRows.length} enabled schedule(s) fire one of them.`,
  ];
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    process.stderr.write("DATABASE_URL is required — the platform database to read\n");
    process.exit(2);
  }
  const sql = new SQL(url, { max: 1 });
  const [agents, schedules] = await sql.begin(async (tx: SQL) => {
    await tx`SET TRANSACTION READ ONLY`;
    return [
      (await tx.unsafe(AGENT_MANIFESTS_QUERY)) as AgentManifestRow[],
      (await tx.unsafe(ENABLED_SCHEDULES_QUERY)) as ScheduleRow[],
    ] as const;
  });
  await sql.close();
  process.stdout.write(`${report(agents, schedules).join("\n")}\n`);
  process.exit(0);
}
