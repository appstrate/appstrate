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
import { getLatestVersionInfo, getVersionDetail } from "./package-versions.ts";

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
/**
 * Resolve a schedule's `version_override` the way the run trigger resolves it
 * (`resolveAgentRunVersion` in `./agent-version-resolver.ts`): absent or
 * `"published"` means the LATEST PUBLISHED version — never the draft — `"draft"`
 * means the working copy, and anything else is an exact version, a dist-tag, or
 * a semver range resolved through `getVersionDetail`.
 *
 * Getting this backwards is what made the first version of this audit
 * untrustworthy: it read an absent override as "draft", so a schedule that in
 * fact runs the latest published version was attributed to the draft artifact.
 * A deploy gate that mis-attributes findings is worse than no gate.
 *
 * Returns the artifact label to attribute the schedule to, or `null` when the
 * selector resolves to nothing (a never-published agent with no override — that
 * schedule already fails at fire time with `no_published_version`).
 */
async function scheduleArtifactLabel(
  packageId: string,
  versionOverride: string | null,
): Promise<string | null> {
  const sel = versionOverride?.trim() || undefined;
  if (sel === "draft") return "draft";
  if (sel === undefined || sel === "published") {
    const latest = await getLatestVersionInfo(packageId).catch(() => null);
    return latest?.version ?? null;
  }
  // Exact version, dist-tag, or semver range — one resolver, same as the run.
  const detail = await getVersionDetail(packageId, sel).catch(() => null);
  return detail?.version ?? null;
}

/**
 * Walk every org-owned agent artifact (draft + each published version) and
 * return the empty-selection findings, annotated with what reaches them.
 *
 * Reachability is computed PER consumer, not pooled: each schedule is judged
 * with its OWN selector and its OWN `dependency_overrides`, because both change
 * which manifest the runtime resolves. Pooling the overrides across a package's
 * schedules — as the first version did — attributes one schedule's finding to
 * every other schedule.
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
    const orgId = agent.orgId;

    const versions = await db
      .select({
        id: packageVersions.id,
        version: packageVersions.version,
        manifest: packageVersions.manifest,
      })
      .from(packageVersions)
      .where(eq(packageVersions.packageId, agent.id));

    // Every artifact a run can reach: the mutable draft (editor Run button,
    // `version=draft`) plus each published version (pin, dist-tag, or range).
    const manifestByLabel = new Map<string, Record<string, unknown>>();
    const draftManifest = asManifest(agent.draftManifest);
    if (draftManifest) manifestByLabel.set("draft", draftManifest);
    const versionIdByLabel = new Map<string, number>();
    for (const v of versions) {
      const m = asManifest(v.manifest);
      if (m) manifestByLabel.set(v.version, m);
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

    // One consumer = one (artifact, overrides) pair to judge. Installs carry no
    // dependency overrides of their own; schedules do.
    interface Consumer {
      label: string;
      overrides: Record<string, string> | null;
      application?: string;
      schedule?: { id: string; nextRunAt: string | null };
    }
    const consumers: Consumer[] = [];
    for (const i of installs) {
      // A pinned install names its version; an unpinned one (`version_id IS
      // NULL`) runs the DRAFT — that is the editor's Run button.
      const label = i.versionId === null ? "draft" : labelForVersionId(versions, i.versionId);
      if (label) consumers.push({ label, overrides: null, application: i.applicationId });
    }
    for (const sc of agentSchedules) {
      const label = await scheduleArtifactLabel(agent.id, sc.versionOverride);
      if (!label) continue;
      consumers.push({
        label,
        overrides: sc.dependencyOverrides ?? null,
        schedule: { id: sc.id, nextRunAt: sc.nextRunAt?.toISOString() ?? null },
      });
    }

    // Judge every artifact once with no overrides so an artifact nothing
    // currently reaches is still reported (informational), then every consumer
    // with its own overrides so reachability is exact.
    const rows = new Map<string, Finding>();
    const record = (
      label: string,
      e: { integrationId: string; reason: string },
      c?: Consumer,
    ): void => {
      const key = `${label}::${e.integrationId}::${e.reason}`;
      const existing = rows.get(key);
      const f: Finding = existing ?? {
        packageId: agent.id,
        artifact: label,
        integrationId: e.integrationId,
        reason: e.reason,
        installedIn: [],
        schedules: [],
      };
      if (c?.application && !f.installedIn.includes(c.application))
        f.installedIn.push(c.application);
      if (c?.schedule && !f.schedules.some((s) => s.id === c.schedule!.id))
        f.schedules.push(c.schedule);
      rows.set(key, f);
    };

    for (const [label, manifest] of manifestByLabel) {
      for (const e of await emptySelections(manifest, orgId, null)) record(label, e);
    }
    for (const c of consumers) {
      const manifest = manifestByLabel.get(c.label);
      if (!manifest) continue;
      for (const e of await emptySelections(manifest, orgId, c.overrides)) record(c.label, e, c);
    }
    findings.push(...rows.values());
  }
  return findings;
}

/** `packages.draft_manifest` / `package_versions.manifest` are jsonb — narrow
 *  rather than cast, per the repo's JSONB read convention. */
function asManifest(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function labelForVersionId(
  versions: ReadonlyArray<{ id: number; version: string }>,
  versionId: number,
): string | null {
  return versions.find((v) => v.id === versionId)?.version ?? null;
}

/** A finding nothing can reach is informational; a reachable one blocks. */
export function isReachable(f: Finding): boolean {
  return f.installedIn.length > 0 || f.schedules.length > 0;
}
