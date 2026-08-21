#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * One-shot data migration for the manifest `config` → `input` collapse.
 * NOT a permanent job — run once per deployment, then never again.
 *
 *   bun scripts/migrate-config-to-input.ts              # dry-run (DEFAULT)
 *   bun scripts/migrate-config-to-input.ts --dry-run    # explicit dry-run
 *   bun scripts/migrate-config-to-input.ts --apply      # migrate
 *
 * WHY IT EXISTS
 *
 * An AFPS agent manifest used to declare two parameter schemas — `input` (per
 * run) and `config` (set once at setup). They are now one: `input`. The
 * platform no longer reads `manifest.config` at all, and the prompt renderer is
 * logic-less Mustache, where an unknown key renders as the EMPTY STRING. A
 * surviving `{{config.days}}` therefore yields a silently truncated prompt with
 * no error anywhere. This script makes sure zero such agents remain.
 *
 * WHAT IT WRITES
 *
 *   packages.draft_manifest    merge `config` into `input`, drop `config`
 *   packages.draft_content     rewrite `{{config.x}}` → `{{input.x}}`
 *   package_versions           REPUBLISH (never UPDATE — see below)
 *   package_schedules          repoint `version_override` off an affected version
 *
 * It never writes `application_packages.input_settings`: the stored values carry
 * over verbatim (same keys, no transformation), so no agent acquires — or
 * loses — a per-field lock as a side effect of this migration.
 *
 * That carry-over is only safe while the surviving `input` property means what
 * the stored value was written against. On a property-name COLLISION it does
 * not: the merge keeps `input`'s property and drops `config`'s, which is the
 * one that typed the value. `--apply` therefore refuses while any collided name
 * still has a stored value — see `blockingCollisions`.
 *
 * WHY REPUBLISH AND NOT UPDATE
 *
 * `package_versions.manifest` is jsonb and technically updatable, but the
 * `prompt.md` lives inside the published ZIP in object storage, and that
 * artifact is integrity-pinned (`package_versions.integrity`, verified at run
 * time by `packages/afps-runtime/src/bundle/read.ts`). Rewriting the ZIP in
 * place would either break the hash or require re-signing a package on its
 * author's behalf. So each affected agent gets a NEW patch version, cut through
 * the normal publish path — `createVersionFromDraft`, the same function
 * `POST /api/packages/agents/{scope}/{name}/versions` calls. Publishing
 * auto-moves the `latest` dist-tag, so unpinned runs pick the clean version
 * immediately.
 *
 * The old affected versions stay: they are immutable by construction. What the
 * assertion enforces is that none of them is still SELECTED — `latest` moved,
 * and no schedule pins one. Yanking is not a substitute: yank is advisory in
 * this codebase (neither `routes/runs.ts` nor `services/scheduler.ts` reads the
 * flag, and an exact pin resolves a yanked version on purpose).
 *
 * SHAPE
 *
 * All pure logic lives in `scripts/lib/config-to-input.ts` so every rule is
 * unit-testable without a live database — same split as
 * `scripts/audit-empty-integration-selections.ts` and
 * `scripts/storage-orphans.ts`. Reads are whole-table SELECTs filtered in
 * TypeScript (`drizzle-orm` is not resolvable from `scripts/`, and the tables
 * involved are operator-scale); writes go through the platform's own service
 * functions, so this script adds no second write path for anything.
 */

import { parseArgs } from "node:util";
import { db } from "@appstrate/db/client";
import {
  applicationPackages,
  organizationMembers,
  packageDistTags,
  packageVersions,
  packages,
  schedules,
} from "@appstrate/db/schema";
import { bumpPatch, compareVersionsDesc } from "@appstrate/core/semver";
import {
  createVersionFromDraft,
  getVersionDetail,
  resolveVersion,
} from "../apps/api/src/services/package-versions.ts";
import { updateOrgItem } from "../apps/api/src/services/package-items/crud.ts";
import { updateSchedule } from "../apps/api/src/services/scheduler.ts";
import {
  asObject,
  blockingCollisions,
  hasConfigReference,
  hasConfigSection,
  inputPropertyNames,
  mergeConfigIntoInput,
  rewriteConfigReferences,
  type JsonObject,
  type MergeReport,
} from "./lib/config-to-input.ts";

function out(line = ""): void {
  process.stdout.write(`${line}\n`);
}

function list(values: string[]): string {
  return values.length > 0 ? values.join(", ") : "—";
}

// ─────────────────────────────────────────────
// Snapshot (read-only)
// ─────────────────────────────────────────────

/**
 * Whole-table reads, filtered in TypeScript.
 *
 * `drizzle-orm` is not resolvable from `scripts/` (it is a dependency of
 * `packages/db`, not of the repo root), so this script cannot build `where`
 * clauses of its own. Every table below is operator-scale — the same trade-off
 * `scripts/storage-orphans.ts` documents for its known-set: fine for a one-shot
 * run, not a hot path.
 */
async function readSnapshot() {
  const [packageRows, versionRows, distTagRows, scheduleRows, installRows, memberRows] =
    await Promise.all([
      db
        .select({
          id: packages.id,
          orgId: packages.orgId,
          type: packages.type,
          ephemeral: packages.ephemeral,
          createdBy: packages.createdBy,
          lockVersion: packages.lockVersion,
          draftManifest: packages.draftManifest,
          draftContent: packages.draftContent,
        })
        .from(packages),
      db
        .select({
          id: packageVersions.id,
          packageId: packageVersions.packageId,
          version: packageVersions.version,
          manifest: packageVersions.manifest,
        })
        .from(packageVersions),
      db
        .select({
          packageId: packageDistTags.packageId,
          tag: packageDistTags.tag,
          versionId: packageDistTags.versionId,
        })
        .from(packageDistTags),
      db
        .select({
          id: schedules.id,
          name: schedules.name,
          packageId: schedules.packageId,
          orgId: schedules.orgId,
          applicationId: schedules.applicationId,
          versionOverride: schedules.versionOverride,
        })
        .from(schedules),
      db
        .select({
          packageId: applicationPackages.packageId,
          applicationId: applicationPackages.applicationId,
          inputSettings: applicationPackages.inputSettings,
        })
        .from(applicationPackages),
      db
        .select({
          orgId: organizationMembers.orgId,
          userId: organizationMembers.userId,
          joinedAt: organizationMembers.joinedAt,
        })
        .from(organizationMembers),
    ]);

  return { packageRows, versionRows, distTagRows, scheduleRows, installRows, memberRows };
}

type Snapshot = Awaited<ReturnType<typeof readSnapshot>>;
type PackageRow = Snapshot["packageRows"][number];

// ─────────────────────────────────────────────
// Inventory model
// ─────────────────────────────────────────────

interface VersionRow {
  id: number;
  version: string;
  manifest: JsonObject;
  /** `prompt.md` extracted from the published ZIP. `null` when unreadable. */
  prompt: string | null;
  manifestHasConfig: boolean;
  promptHasConfigRef: boolean;
}

interface ScheduleRow {
  id: string;
  name: string | null;
  orgId: string;
  applicationId: string;
  versionOverride: string;
  /** Version string the pin currently resolves to, or `null` when unresolvable. */
  resolvedVersion: string | null;
  resolvesToAffected: boolean;
}

interface AgentFinding {
  packageId: string;
  orgId: string;
  ephemeral: boolean;
  createdBy: string | null;
  lockVersion: number;
  draftManifest: JsonObject | null;
  draftContent: string;
  draftManifestAffected: boolean;
  draftPromptRefs: number;
  merge: MergeReport | null;
  /** Newest published version first. */
  versions: VersionRow[];
  affectedVersions: VersionRow[];
  latestTaggedVersion: string | null;
  schedules: ScheduleRow[];
  /** Stored editor values whose key has no property in the migrated `input`. */
  orphanStoredValueKeys: string[];
  /**
   * Collided property names that also carry a stored editor value — the merge
   * dropped the `config` property that typed it, so the value now validates
   * against `input`'s schema. Blocks `--apply`.
   */
  collidingStoredValueKeys: string[];
}

interface Inventory {
  snapshot: Snapshot;
  agentsScanned: number;
  versionsRead: number;
  findings: AgentFinding[];
  /** Non-agent packages carrying a `config` key — outside the AFPS shape. */
  nonAgentAnomalies: string[];
}

/**
 * Build the full inventory. Read-only: every statement is a SELECT, and the ZIP
 * reads go through the same download path the run pipeline uses.
 */
async function buildInventory(): Promise<Inventory> {
  const snapshot = await readSnapshot();
  const { packageRows, versionRows, distTagRows, scheduleRows, installRows } = snapshot;

  // `config` is agent-only in AFPS (§3.2). A skill / integration / mcp-server
  // carrying one is outside the format — report it rather than invent a merge
  // rule for a shape that should not exist.
  const nonAgentAnomalies = packageRows
    .filter((p) => p.type !== "agent" && hasConfigSection(p.draftManifest))
    .map((p) => `${p.id} (type=${p.type})`);

  // System agents (`org_id IS NULL`) are excluded at the source: their draft is
  // re-upserted from `system-packages/` on every boot, none of those manifests
  // declares `config`, and the org-scoped publish path this script reuses
  // refuses them by design.
  const agents = packageRows.filter(
    (p): p is PackageRow & { orgId: string } => p.type === "agent" && p.orgId !== null,
  );
  const agentIds = new Set(agents.map((a) => a.id));

  const versionsByPackage = new Map<string, typeof versionRows>();
  for (const row of versionRows) {
    if (!agentIds.has(row.packageId)) continue;
    const bucket = versionsByPackage.get(row.packageId) ?? [];
    bucket.push(row);
    versionsByPackage.set(row.packageId, bucket);
  }

  const versionById = new Map(versionRows.map((v) => [v.id, v]));
  const latestTagByPackage = new Map<string, string>();
  for (const tag of distTagRows) {
    if (tag.tag !== "latest") continue;
    const version = versionById.get(tag.versionId)?.version;
    if (version) latestTagByPackage.set(tag.packageId, version);
  }

  // Candidate = any `config` signal anywhere on the agent. Only candidates pay
  // for the ZIP reads that detect a prompt-only reference on a published
  // version; an agent that never declared `config` had `{{config.x}}` render
  // empty long before this refactor, so nothing about it changed here.
  const candidates = agents.filter(
    (a) =>
      hasConfigSection(a.draftManifest) ||
      hasConfigReference(a.draftContent) ||
      (versionsByPackage.get(a.id) ?? []).some((v) => hasConfigSection(v.manifest)),
  );

  const findings: AgentFinding[] = [];
  let versionsRead = 0;

  for (const agent of candidates) {
    const draftManifest = asObject(agent.draftManifest);
    const draftContent = agent.draftContent ?? "";
    const merged = draftManifest ? mergeConfigIntoInput(draftManifest) : null;

    const versions: VersionRow[] = [];
    for (const row of versionsByPackage.get(agent.id) ?? []) {
      versionsRead++;
      const detail = await getVersionDetail(agent.id, row.version);
      const prompt = detail?.prompt ?? null;
      versions.push({
        id: row.id,
        version: row.version,
        manifest: asObject(row.manifest) ?? {},
        prompt,
        manifestHasConfig: hasConfigSection(row.manifest),
        promptHasConfigRef: hasConfigReference(prompt),
      });
    }
    // Newest first, so `versions[0]` is the highest published version.
    versions.sort((a, b) => compareVersionsDesc(a.version, b.version));
    const affectedVersions = versions.filter((v) => v.manifestHasConfig || v.promptHasConfigRef);
    const affectedSet = new Set(affectedVersions.map((v) => v.version));

    const scheduleFindings: ScheduleRow[] = [];
    for (const row of scheduleRows) {
      if (row.packageId !== agent.id || row.versionOverride === null) continue;
      const versionId = await resolveVersion(agent.id, row.versionOverride);
      const resolved = versions.find((v) => v.id === versionId)?.version ?? null;
      scheduleFindings.push({
        id: row.id,
        name: row.name,
        orgId: row.orgId,
        applicationId: row.applicationId,
        versionOverride: row.versionOverride,
        resolvedVersion: resolved,
        resolvesToAffected: resolved !== null && affectedSet.has(resolved),
      });
    }

    // Step 5 — the stored editor values carry over verbatim. Surface any key
    // with no property in the MIGRATED input schema: that value would be
    // ignored at launch, and an operator should learn it before, not after.
    const migratedProps = new Set(
      inputPropertyNames(merged ? merged.manifest : (draftManifest ?? {})),
    );
    const storedValueKeys = [
      ...new Set(
        installRows
          .filter((i) => i.packageId === agent.id)
          .flatMap((i) => Object.keys(asObject(i.inputSettings?.values) ?? {})),
      ),
    ];
    const orphanStoredValueKeys = storedValueKeys.filter((key) => !migratedProps.has(key));
    // A collided name whose stored value survives is unrecoverable by script —
    // see `blockingCollisions`. Reported as an anomaly, not a warning.
    const collidingStoredValueKeys = blockingCollisions(
      merged?.report.collisions ?? [],
      storedValueKeys,
    );

    findings.push({
      packageId: agent.id,
      orgId: agent.orgId,
      ephemeral: agent.ephemeral,
      createdBy: agent.createdBy,
      lockVersion: agent.lockVersion,
      draftManifest,
      draftContent,
      draftManifestAffected: hasConfigSection(agent.draftManifest),
      draftPromptRefs: rewriteConfigReferences(draftContent).count,
      merge: merged?.report ?? null,
      versions,
      affectedVersions,
      latestTaggedVersion: latestTagByPackage.get(agent.id) ?? null,
      schedules: scheduleFindings,
      orphanStoredValueKeys,
      collidingStoredValueKeys,
    });
  }

  return {
    snapshot,
    agentsScanned: agents.length,
    versionsRead,
    findings,
    nonAgentAnomalies,
  };
}

/** The patch version a republish would take: one above the highest existing. */
function nextVersionFor(f: AgentFinding): string | null {
  const highest = f.versions[0];
  return highest ? bumpPatch(highest.version) : null;
}

/**
 * Whether a fresh version must be cut, or a clean successor already exists.
 *
 * The old affected versions are immutable and stay for ever, so "this agent has
 * an affected version" is true on every future run and cannot be the trigger —
 * that is what made a naive rerun publish a gratuitous patch every time. The
 * real question is whether the DEFAULT selection is still dirty: the newest
 * version, and whatever the `latest` dist-tag currently points at.
 */
function needsRepublish(f: AgentFinding): boolean {
  const newest = f.versions[0];
  if (!newest || f.affectedVersions.length === 0) return false;
  const affected = new Set(f.affectedVersions.map((v) => v.version));
  return (
    affected.has(newest.version) ||
    (f.latestTaggedVersion !== null && affected.has(f.latestTaggedVersion))
  );
}

/** Whether the migrated draft already differs from the newest published version. */
function draftDivergesFromLatest(f: AgentFinding): boolean {
  const latest = f.versions[0];
  if (!latest) return false;
  const migratedPrompt = rewriteConfigReferences(f.draftContent).content;
  // Compare like with like: the newest version's own prompt is rewritten too,
  // so a draft that only differs by the `config` → `input` rename does not read
  // as an in-flight change.
  if (latest.prompt !== null && rewriteConfigReferences(latest.prompt).content !== migratedPrompt) {
    return true;
  }
  const migratedManifest = f.draftManifest ? mergeConfigIntoInput(f.draftManifest).manifest : null;
  return (
    JSON.stringify(migratedManifest) !==
    JSON.stringify(mergeConfigIntoInput(latest.manifest).manifest)
  );
}

// ─────────────────────────────────────────────
// Report
// ─────────────────────────────────────────────

function reportInventory(inv: Inventory): void {
  out("── Inventory ─────────────────────────────────────────────────");
  out(`  Agent packages scanned      : ${inv.agentsScanned}`);
  out(`  Published versions read     : ${inv.versionsRead} (affected agents only)`);
  out(`  Affected agents             : ${inv.findings.length}`);
  out();

  if (inv.findings.length === 0) {
    out("  No agent carries a `config` section or a `{{config.*}}` reference.");
    out();
    return;
  }

  for (const f of inv.findings) {
    const flags = [
      f.draftManifestAffected || f.draftPromptRefs > 0 ? "draft AFFECTED" : "draft clean",
      f.ephemeral ? "ephemeral" : null,
    ].filter(Boolean);
    out(`  ${f.packageId}  [${flags.join(", ")}]  org=${f.orgId}`);

    if (f.draftManifestAffected && f.merge) {
      out(`    draft manifest   merged into input            : ${list(f.merge.merged)}`);
      out(`                     COLLISION (input wins, dropped): ${list(f.merge.collisions)}`);
      out(`                     required carried over         : ${list(f.merge.requiredAdded)}`);
      out(`                     ui_hints carried over         : ${list(f.merge.uiHintsCarried)}`);
      out(
        `                     file_constraints carried over : ${list(f.merge.fileConstraintsCarried)}`,
      );
      // The AFPS `config` wrapper is `additionalProperties: false` over
      // {schema, file_constraints, ui_hints, property_order, _meta}, and the
      // first four are all carried above. `_meta` is therefore the ONLY member
      // that can be left behind — name it rather than lose it silently.
      if (f.draftManifest && "_meta" in (asObject(f.draftManifest["config"]) ?? {})) {
        out("                     `config._meta` NOT carried    : dropped with the wrapper");
      }
    } else if (f.draftManifestAffected) {
      out("    draft manifest   carries `config` but is not a JSON object — unreadable");
    } else {
      out("    draft manifest   no `config` section");
    }

    out(
      `    draft prompt     ${f.draftPromptRefs} \`{{config.*}}\` reference(s)` +
        (f.draftPromptRefs > 0 ? " → `{{input.*}}`" : ""),
    );

    if (f.affectedVersions.length === 0) {
      out("    published        no affected version — nothing to republish");
    } else {
      for (const v of f.affectedVersions) {
        const why = [
          v.manifestHasConfig ? "manifest config" : null,
          v.promptHasConfigRef ? "prompt refs" : null,
          v.prompt === null ? "prompt UNREADABLE" : null,
        ].filter(Boolean);
        const tag = v.version === f.latestTaggedVersion ? "  ← latest" : "";
        out(`    published        ${v.version} (${why.join(", ")})${tag}`);
      }
      if (!needsRepublish(f)) {
        out(
          `                     → no republish: ${f.versions[0]!.version} is already a clean successor`,
        );
      } else {
        out(
          `                     → republish the draft as ${nextVersionFor(f) ?? "UNKNOWN (no valid semver)"}`,
        );
      }
      if (needsRepublish(f) && draftDivergesFromLatest(f)) {
        out("                     NOTE: the draft differs from the newest published version —");
        out("                           republishing publishes those in-flight changes too.");
      }
    }

    const pinned = f.schedules.filter((s) => s.resolvesToAffected);
    if (pinned.length > 0) {
      for (const s of pinned) {
        out(
          `    schedule pinned  ${s.id}${s.name ? ` "${s.name}"` : ""}` +
            ` version_override=${s.versionOverride} → ${s.resolvedVersion} (repoint)`,
        );
      }
    } else if (f.schedules.length > 0) {
      out(`    schedule pinned  ${f.schedules.length} pin(s), none on an affected version`);
    } else {
      out("    schedule pinned  none");
    }

    if (f.orphanStoredValueKeys.length > 0) {
      out(
        `    stored values    WARNING: no input property for ${list(f.orphanStoredValueKeys)} —` +
          " that value is ignored at launch",
      );
    }
    out();
  }
}

/** Report shapes this migration has no rule for. Returns true when apply must refuse. */
function reportAnomalies(inv: Inventory): boolean {
  const collisionAnomalies = inv.findings.filter((f) => f.collidingStoredValueKeys.length > 0);
  if (inv.nonAgentAnomalies.length === 0 && collisionAnomalies.length === 0) {
    return false;
  }
  out("── Anomalies ─────────────────────────────────────────────────");
  if (inv.nonAgentAnomalies.length > 0) {
    out("  Non-agent packages carrying a `config` section (outside AFPS §3.2):");
    for (const id of inv.nonAgentAnomalies) out(`    ${id}`);
    out("  This migration has no merge rule for them. Resolve by hand first.");
  }
  if (collisionAnomalies.length > 0) {
    out("  Collisions whose stored value was typed by the DROPPED `config` property:");
    for (const f of collisionAnomalies) {
      out(`    ${f.packageId}  ${list(f.collidingStoredValueKeys)}`);
    }
    out(
      "  `application_packages.input_settings` is never rewritten, so those values would be read",
    );
    out("  as `input` and validated against the property `input` kept — a type mismatch");
    out(
      "  fails EVERY launch, and `PUT /api/agents/{scope}/{name}/input-settings` refuses the same",
    );
    out("  value, so it cannot be cleared from the UI either. Which type was meant is not");
    out("  in the data: reconcile the stored value or the schema by hand first.");
  }
  out();
  return true;
}

// ─────────────────────────────────────────────
// Apply
// ─────────────────────────────────────────────

/** Resolve a user id to attribute the republished version to. */
function resolveActor(f: AgentFinding, snapshot: Snapshot): string | null {
  if (f.createdBy) return f.createdBy;
  const oldest = snapshot.memberRows
    .filter((m) => m.orgId === f.orgId)
    .sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime())[0];
  return oldest?.userId ?? null;
}

/**
 * Rewrite the mutable draft through the platform's own draft write path
 * (`updateOrgItem`): manifest and prompt move in ONE statement guarded by the
 * package's `lock_version`, so the two can never disagree and a concurrent
 * editor save is refused rather than silently overwritten. No-op when the draft
 * is already migrated.
 */
async function migrateDraft(f: AgentFinding): Promise<boolean> {
  if (!f.draftManifestAffected && f.draftPromptRefs === 0) return false;
  if (!f.draftManifest) {
    // `updateOrgItem` writes both columns, so migrating the prompt of a draft
    // whose manifest is absent would replace that NULL with `{}`. Refuse loudly
    // instead of inventing a manifest.
    throw new Error(
      `${f.packageId}: draft_content references \`config\` but draft_manifest is absent — resolve by hand`,
    );
  }
  const manifest = mergeConfigIntoInput(f.draftManifest).manifest;
  const content = rewriteConfigReferences(f.draftContent).content;
  const updated = await updateOrgItem(f.orgId, f.packageId, { manifest, content }, f.lockVersion);
  if (!updated) {
    throw new Error(
      `${f.packageId}: draft changed under the migration (lock_version ${f.lockVersion} is stale) — re-run`,
    );
  }
  return true;
}

/**
 * Ensure a clean published version exists, and return it.
 *
 * Reuses `createVersionFromDraft` — the exact function the publish route
 * (`POST /api/packages/agents/{scope}/{name}/versions`) calls. It assembles the
 * ZIP, computes the integrity hash, uploads the artifact and inserts the version
 * row inside one transaction holding a per-package advisory lock, and moves the
 * `latest` dist-tag. Nothing here hand-rolls any of that.
 *
 * Idempotent: once a clean successor exists and carries the `latest` tag,
 * {@link needsRepublish} is false and the existing version is returned instead
 * of cutting another patch.
 */
async function ensureCleanVersion(
  f: AgentFinding,
  snapshot: Snapshot,
): Promise<{ version: string; published: boolean }> {
  if (!needsRepublish(f)) return { version: f.versions[0]!.version, published: false };

  const target = nextVersionFor(f);
  if (!target) {
    throw new Error(`${f.packageId}: no valid semver among published versions — cannot bump`);
  }
  const userId = resolveActor(f, snapshot);
  if (!userId) {
    throw new Error(`${f.packageId}: org ${f.orgId} has no member to attribute the version to`);
  }

  const result = await createVersionFromDraft({
    packageId: f.packageId,
    orgId: f.orgId,
    userId,
    version: target,
  });

  if ("error" in result) {
    throw new Error(
      `${f.packageId}: publish failed (${result.error}${result.detail ? `: ${result.detail}` : ""})`,
    );
  }
  return { version: result.version, published: true };
}

/**
 * Repoint every schedule whose pin still resolves to an affected version.
 *
 * Goes through `updateSchedule` — the platform's own schedule write path — so
 * the BullMQ repeatable job is re-registered with the new pin instead of being
 * left behind by a raw UPDATE.
 */
async function repointSchedules(f: AgentFinding, cleanVersion: string): Promise<string[]> {
  const affected = new Set(f.affectedVersions.map((v) => v.version));
  const moved: string[] = [];
  for (const s of f.schedules) {
    // Re-resolve AFTER the republish: a pin on the `latest` dist-tag has
    // already followed the new version and must not be frozen to a literal.
    const versionId = await resolveVersion(f.packageId, s.versionOverride);
    const resolved = f.versions.find((v) => v.id === versionId)?.version ?? null;
    if (resolved === null || !affected.has(resolved)) continue;
    const updated = await updateSchedule({ orgId: s.orgId, applicationId: s.applicationId }, s.id, {
      versionOverride: cleanVersion,
    });
    if (!updated) throw new Error(`${f.packageId}: schedule ${s.id} vanished mid-migration`);
    moved.push(`${s.id} (${resolved} → ${cleanVersion})`);
  }
  return moved;
}

/** `@scope/name@version` of every version this run published. */
async function apply(inv: Inventory): Promise<string[]> {
  const republished: string[] = [];
  const succeeded: string[] = [];

  out("── Apply ─────────────────────────────────────────────────────");
  for (const f of inv.findings) {
    try {
      const draftChanged = await migrateDraft(f);
      out(`  ${f.packageId}  draft ${draftChanged ? "migrated" : "already clean"}`);

      if (f.affectedVersions.length > 0) {
        const { version, published } = await ensureCleanVersion(f, inv.snapshot);
        if (published) republished.push(`${f.packageId}@${version}`);
        out(`  ${f.packageId}  ${published ? `published ${version}` : `${version} already clean`}`);
        const moved = await repointSchedules(f, version);
        out(`  ${f.packageId}  schedules repointed: ${moved.length > 0 ? list(moved) : "none"}`);
      }
      succeeded.push(f.packageId);
    } catch (err) {
      out();
      out(`  FAILED on ${f.packageId}: ${err instanceof Error ? err.message : String(err)}`);
      out(`  Agents fully migrated before the failure (${succeeded.length}): ${list(succeeded)}`);
      out("  Every step above committed on its own; re-running --apply resumes safely.");
      throw err;
    }
  }
  out();
  return republished;
}

// ─────────────────────────────────────────────
// Final assertion
// ─────────────────────────────────────────────

/**
 * Re-read the database from scratch and prove no reachable residue survives.
 *
 * `republished` names the versions this run published, so their manifest and
 * their `prompt.md` (read back out of the uploaded ZIP) are checked explicitly
 * rather than inferred.
 *
 * A legacy affected version is deliberately NOT residue on its own: a published
 * version is immutable (its `prompt.md` lives inside an integrity-pinned ZIP),
 * so those rows keep their `config` for ever. Their count is reported. What must
 * hold is that none of them is still SELECTED — the `latest` dist-tag moved to
 * the republished version, and no schedule pins one.
 */
async function assertClean(republished: string[]): Promise<boolean> {
  const inv = await buildInventory();
  const { packageRows } = inv.snapshot;

  // Every category this migration is responsible for, in one list. Each entry
  // names WHERE it was found, so a bare package id cannot be confused between
  // the manifest and the prompt category.
  const residue: string[] = [];

  for (const id of republished) {
    const at = id.lastIndexOf("@");
    const detail = await getVersionDetail(id.slice(0, at), id.slice(at + 1));
    if (hasConfigSection(detail?.manifest)) residue.push(`${id} (republished manifest)`);
    if (hasConfigReference(detail?.prompt)) residue.push(`${id} (republished prompt.md)`);
  }

  for (const p of packageRows) {
    if (hasConfigSection(p.draftManifest)) residue.push(`${p.id} (packages.draft_manifest)`);
    if (hasConfigReference(p.draftContent)) residue.push(`${p.id} (packages.draft_content)`);
  }

  let legacyAffected = 0;
  for (const f of inv.findings) {
    for (const v of f.affectedVersions) {
      legacyAffected++;
      if (v.version === f.latestTaggedVersion) {
        residue.push(`${f.packageId}@${v.version} (legacy version still tagged \`latest\`)`);
      }
    }
    for (const s of f.schedules) {
      if (s.resolvesToAffected) {
        residue.push(`${s.id} (schedule pinned to ${f.packageId}@${s.resolvedVersion})`);
      }
    }
  }

  out("── Final assertion ───────────────────────────────────────────");
  for (const id of residue) out(`  RESIDUE ${id}`);
  out(
    `  legacy published versions still carrying \`config\`: ${legacyAffected}` +
      " (immutable — kept, but no longer selected by default)",
  );
  out(residue.length === 0 ? "PASS — no reachable `config` residue." : "FAIL — residue survived.");
  return residue.length === 0;
}

// ─────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "dry-run": { type: "boolean" },
      apply: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });

  if (values.help) {
    out("Usage: bun scripts/migrate-config-to-input.ts [--dry-run | --apply]");
    out("  --dry-run  (default) inventory + report, writes nothing");
    out("  --apply    migrate drafts, republish affected agents, repoint pins, assert");
    return 0;
  }

  if (values["dry-run"] && values.apply) {
    out("Pick exactly one of --dry-run, --apply.");
    return 1;
  }

  const inv = await buildInventory();
  reportInventory(inv);
  const blocked = reportAnomalies(inv);

  if (!values.apply) {
    out("Dry-run: nothing was written. Re-run with --apply to migrate.");
    return blocked ? 1 : 0;
  }
  if (blocked) {
    out("Refusing to apply while the anomalies above are unresolved.");
    return 1;
  }

  const republished = await apply(inv);
  const ok = await assertClean(republished);
  out();
  out(ok ? "Migration complete." : "Migration did NOT reach a clean state.");
  return ok ? 0 : 1;
}

if (import.meta.main) {
  try {
    process.exit(await main());
  } catch (err) {
    // `parseArgs` is strict, and every apply-path failure re-throws after
    // reporting which agents were migrated. Surface the message, not a stack.
    out(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
