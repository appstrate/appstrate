// SPDX-License-Identifier: Apache-2.0

/**
 * Pre-deploy audit for the zero-callable integration gate.
 *
 * Finds every agent artifact whose declared integration would expose no
 * callable tool — the state `assertIntegrationExposesTools` turns into a failed
 * run — and reports, per row, whether it is merely explicitly selectable or
 * actively targeted by an application default / enabled schedule.
 *
 * WHY NOT A SQL QUERY. A SQL approximation shipped first and was wrong in three
 * ways a query cannot fix without reimplementing the platform:
 *
 *  - It read the integration's `draft_manifest` for `default_tools`, while a run
 *    reads the manifest at the version the agent's pin resolves to. Semver
 *    ranges and dist-tags are not resolvable in SQL.
 *  - It looked only at `package_versions`, so mutable drafts were invisible
 *    even though an installed package makes them selector-runnable and the
 *    editor's Run button explicitly executes the draft.
 *  - It ignored `dependency_overrides`, which can point one dependency at
 *    `draft` per schedule, changing which manifest is judged.
 *
 * This calls the same callability validator as every freeze point, which in
 * turn calls the runtime's version and tool-catalog resolvers. Read-only.
 *
 * CLI wrapper: `scripts/maintenance/audit-empty-integration-selections.ts`.
 */

import { parseManifestIntegrations } from "@appstrate/core/dependencies";
import { db } from "@appstrate/db/client";
import { applicationPackages, packageVersions, packages, schedules } from "@appstrate/db/schema";
import { eq, and } from "drizzle-orm";

import { validateAgentIntegrationSelections } from "./integration-scope-validation.ts";
import { getLatestVersionInfo, getVersionDetail } from "./package-versions.ts";

export interface Finding {
  packageId: string;
  /** `draft`, or the published version label. */
  artifact: string;
  integrationId: string;
  reason: string;
  /** Applications where this package is installed, making this artifact explicitly selectable. */
  installedIn: string[];
  /**
   * Applications where a normal run/export path selects this artifact without
   * an explicit version selector. These findings block rollout.
   */
  activeIn: string[];
  /** Enabled schedules pointed at it, with their next fire time. */
  schedules: Array<{ id: string; nextRunAt: string | null }>;
}

/**
 * Which integrations of `agentManifest` resolve to zero callable tools.
 *
 * This deliberately calls the freeze-point validator rather than reimplementing
 * its predicate. Selection length is insufficient: `default_tools: ["x"]`
 * where `x` is hidden or absent from the resolved mcp-server is non-empty but
 * still aborts at boot.
 */
async function emptySelections(
  agentManifest: Record<string, unknown>,
  orgId: string,
  dependencyOverrides: Record<string, string> | null,
): Promise<Array<{ integrationId: string; reason: string }>> {
  const declared = parseManifestIntegrations(agentManifest);
  if (declared.length === 0) return [];

  const errors = await validateAgentIntegrationSelections({
    manifest: agentManifest,
    orgId,
    requireCallableTools: true,
    ...(dependencyOverrides ? { dependencyOverrides } : {}),
  });
  const noToolsFields = new Set(
    errors.filter((e) => e.code === "no_tools_selected").map((e) => e.field),
  );
  return declared
    .filter((entry) => noToolsFields.has(`integrations_configuration.${entry.id}.tools`))
    .map((entry) => ({
      integrationId: entry.id,
      reason:
        entry.tools === undefined
          ? "inherited selection exposes no callable tool"
          : Array.isArray(entry.tools) && entry.tools.length === 0
            ? "explicit empty tool selection"
            : "selected tools are unavailable or hidden",
    }));
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
    const latest = await getLatestVersionInfo(packageId);
    return latest?.version ?? null;
  }
  // Exact version, dist-tag, or semver range — one resolver, same as the run.
  const detail = await getVersionDetail(packageId, sel);
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
    const labelByVersionId = new Map<number, string>();
    const draftManifest = asManifest(agent.draftManifest);
    if (draftManifest) manifestByLabel.set("draft", draftManifest);
    for (const v of versions) {
      const m = asManifest(v.manifest);
      if (m) manifestByLabel.set(v.version, m);
      labelByVersionId.set(v.id, v.version);
    }
    const latest = await getLatestVersionInfo(agent.id);

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
      activeApplication?: string;
      schedule?: { id: string; nextRunAt: string | null };
    }
    const consumers: Consumer[] = [];
    for (const i of installs) {
      // Installation grants access to the PACKAGE, not one immutable artifact:
      // `/run?version=` accepts draft, exact, tag and range, and the editor's
      // Run button explicitly selects the draft. A version_id is a default pin,
      // not a permission boundary, so every artifact remains visible in the
      // audit. Only the latest published version (normal run default) and the
      // installed version pin (bundle/export default) block rollout; drafts and
      // historical versions that need an explicit selector are warnings.
      const activeLabels = new Set<string>();
      if (latest?.version) activeLabels.add(latest.version);
      if (i.versionId !== null) {
        const installedLabel = labelByVersionId.get(i.versionId);
        if (installedLabel) activeLabels.add(installedLabel);
      }
      for (const label of manifestByLabel.keys()) {
        consumers.push({
          label,
          overrides: null,
          application: i.applicationId,
          ...(activeLabels.has(label) ? { activeApplication: i.applicationId } : {}),
        });
      }
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
        activeIn: [],
        schedules: [],
      };
      if (c?.application && !f.installedIn.includes(c.application))
        f.installedIn.push(c.application);
      if (c?.activeApplication && !f.activeIn.includes(c.activeApplication))
        f.activeIn.push(c.activeApplication);
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

/** Explicitly selectable or scheduled; useful for inventory and warnings. */
export function isReachable(f: Finding): boolean {
  return f.installedIn.length > 0 || f.schedules.length > 0;
}

/**
 * Blocking means execution is an active default, not merely possible through
 * an explicit selector. Enabled schedules always block, including schedules
 * that intentionally target the draft.
 */
export function isBlocking(f: Finding): boolean {
  return f.activeIn.length > 0 || f.schedules.length > 0;
}
