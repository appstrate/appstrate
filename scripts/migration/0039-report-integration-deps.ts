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
 * ENABLED schedule firing such an agent — the version its `version_override` names included,
 * which is listed with the agents. An integration printed `optional` used to refuse a run with
 * no usable connection; after the deploy that run starts without it. Also counts the enabled
 * schedules whose `connection_overrides` hold an empty set: no write could store one before the
 * deploy, so anything but 0 is a row to inspect. Writes nothing (one READ ONLY transaction);
 * exits 0, 2 without `DATABASE_URL`.
 */

import { SQL } from "bun";
import { parseManifestIntegrations } from "@appstrate/core/dependencies";
import { resolveVersionFromCatalog } from "@appstrate/core/semver";

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
  has_empty_set: boolean;
}

interface VersionRow {
  id: number;
  package_id: string;
  version: string;
  yanked: boolean;
  manifest: string;
}

interface DistTagRow {
  package_id: string;
  tag: string;
  version_id: number;
}

export interface ReportSnapshot {
  agents: AgentManifestRow[];
  schedules: ScheduleRow[];
  /** Every version of an agent an enabled schedule pins with `version_override`. */
  versions: VersionRow[];
  distTags: DistTagRow[];
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
         sc.version_override, sc.connection_overrides::text AS connection_overrides,
         EXISTS (SELECT 1 FROM jsonb_each(sc.connection_overrides) e
                  WHERE e.value = '[]'::jsonb) AS has_empty_set
    FROM package_schedules sc
    JOIN organizations o ON o.id = sc.org_id
    JOIN spaces s ON s.id = sc.space_id
   WHERE sc.enabled
   ORDER BY 1, 2, 5, 3`;

const PINNED_PACKAGES = `
  SELECT package_id FROM package_schedules WHERE enabled AND version_override IS NOT NULL`;

const PINNED_VERSIONS_QUERY = `
  SELECT id, package_id, version, yanked, manifest::text AS manifest
    FROM package_versions
   WHERE package_id IN (${PINNED_PACKAGES})`;

const PINNED_DIST_TAGS_QUERY = `
  SELECT package_id, tag, version_id
    FROM package_dist_tags
   WHERE package_id IN (${PINNED_PACKAGES})`;

/** Every row the report reads, through `run` (one statement, its rows). */
export async function readSnapshot(
  run: (query: string) => Promise<unknown[]>,
): Promise<ReportSnapshot> {
  return {
    agents: (await run(AGENT_MANIFESTS_QUERY)) as AgentManifestRow[],
    schedules: (await run(ENABLED_SCHEDULES_QUERY)) as ScheduleRow[],
    versions: (await run(PINNED_VERSIONS_QUERY)) as VersionRow[],
    distTags: (await run(PINNED_DIST_TAGS_QUERY)) as DistTagRow[],
  };
}

/** The published version `version_override` names, resolved as a fire resolves it; else null. */
function pinnedVersion(
  schedule: ScheduleRow,
  versions: readonly VersionRow[],
  distTags: readonly DistTagRow[],
): VersionRow | null {
  const selector = schedule.version_override;
  // `draft` and `published` select the draft and `latest` rows, already listed.
  if (!selector || selector === "draft" || selector === "published") return null;
  const own = versions.filter((v) => v.package_id === schedule.package_id);
  const id = resolveVersionFromCatalog(
    selector,
    own.map((v) => ({ id: v.id, version: v.version, yanked: v.yanked })),
    distTags
      .filter((t) => t.package_id === schedule.package_id)
      .map((t) => ({ tag: t.tag, versionId: t.version_id })),
  );
  return own.find((v) => v.id === id) ?? null;
}

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
export function report({ agents, schedules, versions, distTags }: ReportSnapshot): string[] {
  const listed = new Set(agents.map((a) => `${a.id}@${a.version}`));
  const homeOf = new Map(agents.map((a) => [a.id, a]));
  const pinned = schedules.flatMap((s): AgentManifestRow[] => {
    const v = pinnedVersion(s, versions, distTags);
    const home = homeOf.get(s.package_id);
    if (!v || !home || listed.has(`${v.package_id}@${v.version}`)) return [];
    listed.add(`${v.package_id}@${v.version}`);
    return [{ ...home, version: v.version, manifest: v.manifest }];
  });
  const byKey = (a: AgentManifestRow) => [a.org, a.space, a.id, a.version].join("\u0000");
  const agentRows = [...agents, ...pinned]
    .sort((a, b) => (byKey(a) < byKey(b) ? -1 : byKey(a) > byKey(b) ? 1 : 0))
    .flatMap((a) =>
      integrationsOf(a.manifest).map((integration) => [
        a.org,
        a.space,
        a.id,
        a.version,
        integration,
      ]),
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
  const emptySets = schedules.filter((s) => s.has_empty_set).length;
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
    `${emptySets} enabled schedule(s) hold an empty connection set (expected 0).`,
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
