// SPDX-License-Identifier: Apache-2.0

/**
 * Pre-deploy audit for the declared-but-empty integration gate.
 *
 * Finds every agent artifact whose declared integration would expose no
 * callable tool — the state `assertIntegrationExposesTools` turns into a failed
 * run — and reports, per row, whether anything can actually reach it.
 *
 * WHY NOT A SQL QUERY. A SQL approximation shipped first and was wrong in three
 * ways a query cannot fix without reimplementing the platform:
 *
 *  - It read the integration's `draft_manifest` for `default_tools`, while a run
 *    reads the manifest at the version the agent's pin resolves to. Semver
 *    ranges and dist-tags are not resolvable in SQL.
 *  - It looked only at `package_versions`, so an installed DRAFT (`version_id
 *    IS NULL` — what the editor's Run button executes) was invisible. Live
 *    installs were missed that way.
 *  - It ignored `dependency_overrides`, which can point one dependency at
 *    `draft` per schedule, changing which manifest is judged.
 *
 * This calls the resolvers the runtime calls, so "empty" means here exactly what
 * it will mean at boot. Read-only.
 *
 * CLI wrapper: `scripts/audit-empty-integration-selections.ts`.
 */

import { resolveEffectiveToolSelection } from "@appstrate/core/integration";
import { isToolsWildcard, parseManifestIntegrations } from "@appstrate/core/dependencies";
import { db } from "@appstrate/db/client";
import { applicationPackages, packageVersions, packages, schedules } from "@appstrate/db/schema";
import { eq, and } from "drizzle-orm";

import {
  resolveRunIntegrationVersions,
  type IntegrationManifestCache,
} from "./integration-service.ts";

export interface Finding {
  packageId: string;
  /** `draft`, or the published version label. */
  artifact: string;
  integrationId: string;
  reason: string;
  /** Applications where this exact artifact is installed and therefore runnable. */
  installedIn: string[];
  /** Enabled schedules pointed at it, with their next fire time. */
  schedules: Array<{ id: string; nextRunAt: string | null }>;
}

/**
 * Which integrations of `agentManifest` resolve to an empty effective
 * selection. Mirrors `selectsNoCallableTool` in
 * `apps/api/src/services/integration-scope-validation.ts` — kept as a call into
 * the same two core helpers rather than a reimplementation.
 */
async function emptySelections(
  agentManifest: Record<string, unknown>,
  orgId: string,
  dependencyOverrides: Record<string, string> | null,
): Promise<Array<{ integrationId: string; reason: string }>> {
  const declared = parseManifestIntegrations(agentManifest);
  if (declared.length === 0) return [];

  const cache: IntegrationManifestCache = new Map();
  await resolveRunIntegrationVersions({
    agentManifest,
    orgId,
    ...(dependencyOverrides ? { dependencyOverrides } : {}),
    manifestCache: cache,
  });

  const out: Array<{ integrationId: string; reason: string }> = [];
  for (const entry of declared) {
    const pending = cache.get(entry.id);
    if (!pending) {
      // Unresolvable pin — a different, louder failure (`dependency_unresolved`,
      // 422) already owns this case. Not this gate's finding.
      continue;
    }
    const res = await pending;
    if (!res.ok) continue;
    const effective = resolveEffectiveToolSelection(entry.tools, res.manifest);
    if (isToolsWildcard(effective)) continue;
    if (effective !== undefined && effective.length > 0) continue;
    out.push({
      integrationId: entry.id,
      reason:
        entry.tools === undefined
          ? "no selection, and the resolved integration declares no default_tools"
          : "explicit empty tool selection",
    });
  }
  return out;
}

/**
 * Walk every org-owned agent artifact (draft + each published version) and
 * return the empty-selection findings, annotated with what reaches them.
 */
export async function auditEmptyIntegrationSelections(): Promise<Finding[]> {
  const findings: Finding[] = [];

  const agents = await db
    .select({ id: packages.id, orgId: packages.orgId, draftManifest: packages.draftManifest })
    .from(packages)
    .where(eq(packages.type, "agent"));

  for (const agent of agents) {
    // System agents carry `orgId: null` and are not org artifacts.
    if (!agent.orgId) continue;

    // Every artifact a run can reach: the mutable draft (editor Run button,
    // `dependency_overrides`) plus each published version (pin or dist-tag).
    const artifacts: Array<{ label: string; manifest: Record<string, unknown> | null }> = [
      { label: "draft", manifest: agent.draftManifest as Record<string, unknown> | null },
    ];
    const versions = await db
      .select({
        id: packageVersions.id,
        version: packageVersions.version,
        manifest: packageVersions.manifest,
      })
      .from(packageVersions)
      .where(eq(packageVersions.packageId, agent.id));
    const versionIdByLabel = new Map<string, number>();
    for (const v of versions) {
      artifacts.push({ label: v.version, manifest: v.manifest as Record<string, unknown> | null });
      versionIdByLabel.set(v.version, v.id);
    }

    const installs = await db
      .select({
        applicationId: applicationPackages.applicationId,
        versionId: applicationPackages.versionId,
      })
      .from(applicationPackages)
      .where(eq(applicationPackages.packageId, agent.id));
    const agentSchedules = await db
      .select({
        id: schedules.id,
        nextRunAt: schedules.nextRunAt,
        versionOverride: schedules.versionOverride,
        dependencyOverrides: schedules.dependencyOverrides,
      })
      .from(schedules)
      .where(and(eq(schedules.packageId, agent.id), eq(schedules.enabled, true)));

    for (const artifact of artifacts) {
      if (!artifact.manifest) continue;
      // Overrides are per-run/per-schedule: judge the default path once, plus
      // each distinct schedule override that actually exists.
      const overrideSets: Array<Record<string, string> | null> = [null];
      for (const s of agentSchedules) {
        if (s.dependencyOverrides) overrideSets.push(s.dependencyOverrides);
      }

      const seen = new Set<string>();
      for (const overrides of overrideSets) {
        const empties = await emptySelections(artifact.manifest, agent.orgId, overrides);
        for (const e of empties) {
          const key = `${e.integrationId}::${e.reason}`;
          if (seen.has(key)) continue;
          seen.add(key);

          // An install reaches the DRAFT precisely when it pinned no version.
          const installedIn = installs
            .filter((i) =>
              artifact.label === "draft"
                ? i.versionId === null
                : i.versionId === versionIdByLabel.get(artifact.label),
            )
            .map((i) => i.applicationId);
          const reaching = agentSchedules
            .filter((s) =>
              artifact.label === "draft"
                ? !s.versionOverride
                : s.versionOverride === artifact.label,
            )
            .map((s) => ({ id: s.id, nextRunAt: s.nextRunAt?.toISOString() ?? null }));

          findings.push({
            packageId: agent.id,
            artifact: artifact.label,
            integrationId: e.integrationId,
            reason: e.reason,
            installedIn,
            schedules: reaching,
          });
        }
      }
    }
  }
  return findings;
}

/** A finding nothing can reach is informational; a reachable one blocks. */
export function isReachable(f: Finding): boolean {
  return f.installedIn.length > 0 || f.schedules.length > 0;
}
