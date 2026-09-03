// SPDX-License-Identifier: Apache-2.0

/**
 * `appstrate skills sync` — the pinned space's skills as Agent Skills
 * directories, run by a *machine*: a Claude Code marketplace `command` source
 * re-runs it once per session in the background. So `--print-path` writes
 * exactly one stdout line and only on success, and a per-skill failure must
 * NOT fail the process — Claude Code discards a run that exits non-zero, which
 * would throw away a correct plugin over a skill that was never in it.
 */

import { mapWithConcurrency } from "@appstrate/core/map-with-concurrency";
import { resolveActiveProfile, type Profile } from "../lib/config.ts";
import { DEFAULT_IO, type CommandIO } from "../lib/io.ts";
import { formatError } from "../lib/ui.ts";
import { checkSkillMarkdown } from "@appstrate/afps-shared/companion-files";
import { materializeSkill, SKILL_ENTRY } from "../lib/skills-sync/materialize.ts";
import { withSyncLock } from "../lib/skills-sync/lock.ts";
import {
  assignSlugs,
  diffTarget,
  fetchSkillFiles,
  listSyncableSkills,
  MAX_CONCURRENCY,
  ownedLedger,
  resolveSkill,
  type Catalogue,
  type PlannedSkill,
  type ResolvedSkill,
  type SkillsBySlug,
  type SkillSource,
  type TargetPlan,
} from "../lib/skills-sync/plan.ts";
import {
  readSyncState,
  STATE_VERSION,
  writeSyncState,
  type ManagedSkill,
  type SyncState,
} from "../lib/skills-sync/state.ts";
import {
  pluginTreeMatches,
  removeManagedDir,
  setupPluginFiles,
  skillDir,
  targetRoot,
  writePluginTree,
  writeSetupPlugin,
  writeSharedSkill,
  type SkillTree,
  type SyncTarget,
} from "../lib/skills-sync/targets.ts";

export interface SkillsSyncOptions {
  profile?: string;
  target?: SyncTarget[];
  source?: SkillSource;
  printPath?: boolean;
  dryRun?: boolean;
}

interface LineSink {
  write(chunk: string): void;
}

interface Report {
  /** Per-skill failure: information under `--print-path`, exit 1 otherwise. */
  skill(message: string): void;
  /** Whole-run failure: the plugin on disk is not what the server describes. */
  run(message: string): void;
  /** Worth telling the user, not worth an exit code. */
  note(message: string): void;
}

export async function skillsSyncCommand(
  opts: SkillsSyncOptions,
  io: CommandIO = DEFAULT_IO,
): Promise<void> {
  const targets = uniqueTargets(opts.target);
  const source: SkillSource = opts.source ?? "published";
  const printPath = opts.printPath === true;

  if (printPath && !targets.includes("claude-plugin")) {
    io.stderr.write(
      "--print-path prints the Claude Code plugin directory. Add: --target claude-plugin\n",
    );
    io.exit(1);
  }
  if (printPath && opts.dryRun) {
    // A dry run builds nothing, so the path would name a directory that may
    // not exist and a marketplace source would install a stale plugin.
    io.stderr.write(
      "--print-path cannot be combined with --dry-run: a dry run writes no plugin.\n",
    );
    io.exit(1);
  }

  const { profileName, profile } = await resolveActiveProfile(opts.profile);
  const gap = connectionGap(profileName, profile);
  if (gap && !printPath) {
    io.stderr.write(`${gap.problem}. Run: ${gap.remedy}\n`);
    io.exit(1);
  }

  // Two grades, because `--print-path` treats them differently.
  let skillFailures = 0;
  let runFailures = 0;
  const report: Report = {
    skill: (message) => {
      skillFailures += 1;
      io.stderr.write(`${message}\n`);
    },
    run: (message) => {
      runFailures += 1;
      io.stderr.write(`${message}\n`);
    },
    note: (message) => io.stderr.write(`${message}\n`),
  };
  // Only read under `--print-path`, which already requires `claude-plugin`.
  let pluginOk = false;

  try {
    await withSyncLock(async () => {
      const { state, corrupt } = await readSyncState();
      if (corrupt) {
        io.stderr.write(
          "Sync state could not be used and has been ignored — this run re-materializes everything.\n",
        );
      }

      if (gap) {
        pluginOk = await bootstrapPlugin(gap, state, source, report);
        return;
      }

      const catalogue = await resolveAll(profileName, source, state, targets, report);
      const plans = await Promise.all(
        targets.map((target) => diffTarget(target, catalogue, state, source)),
      );
      for (const plan of plans) {
        for (const slug of plan.blocked) {
          report.skill(
            `Skipped ${catalogue.bySlug.get(slug)!.packageId} on ${plan.target}: ${skillDir(plan.target, slug)} exists and is not managed by appstrate — remove or rename it`,
          );
        }
      }

      if (opts.dryRun) {
        reportPlans(plans, io.stdout);
        return;
      }
      pluginOk = await executePlans(profileName, source, plans, state, catalogue.bySlug, report);
      if (!printPath) reportPlans(plans, io.stdout);
    });
  } catch (err) {
    report.run(formatError(err));
    pluginOk = false;
  }

  const failed = printPath ? runFailures > 0 || !pluginOk : runFailures + skillFailures > 0;
  if (!failed && printPath) io.stdout.write(`${targetRoot("claude-plugin")}\n`);
  if (failed) io.exit(1);
}

interface ConnectionGap {
  problem: string;
  remedy: string;
}

/** What still separates this profile from a syncable space, if anything. */
function connectionGap(profileName: string, profile: Profile | undefined): ConnectionGap | null {
  if (!profile) {
    return {
      problem: `Profile "${profileName}" not configured`,
      remedy: `appstrate login --profile ${profileName}`,
    };
  }
  if (!profile.orgId) return { problem: "No organization pinned", remedy: "appstrate org switch" };
  if (!profile.spaceId) return { problem: "No space pinned", remedy: "appstrate space switch" };
  return null;
}

/**
 * `--print-path` before the CLI is connected: a marketplace install must still
 * succeed, so it gets a plugin whose only skill says how to connect. Only on a
 * FRESH plugin — an existing one is kept and the run fails as before, so a
 * lapsed login never takes working skills away.
 */
async function bootstrapPlugin(
  gap: ConnectionGap,
  state: SyncState,
  source: SkillSource,
  report: Report,
): Promise<boolean> {
  const message = `${gap.problem}. Run: ${gap.remedy}`;
  if (Object.keys(ownedLedger("claude-plugin", state, source).managed).length > 0) {
    report.run(message);
    return false;
  }
  report.note(message);
  try {
    await writeSetupPlugin(targetRoot("claude-plugin"), setupPluginFiles(gap.problem, gap.remedy));
    return true;
  } catch (err) {
    report.run(`Failed to write claude-plugin: ${formatError(err)}`);
    return false;
  }
}

/**
 * List the space's skills, pin each to an artifact, and assign directory
 * names. A skill with no published version is a note, not a failure.
 */
async function resolveAll(
  profileName: string,
  source: SkillSource,
  state: SyncState,
  targets: SyncTarget[],
  report: Report,
): Promise<Catalogue> {
  const packageIds = await listSyncableSkills(profileName);
  const resolutions = await mapWithConcurrency(packageIds, MAX_CONCURRENCY, async (packageId) => {
    try {
      return { packageId, skill: await resolveSkill(profileName, packageId, source) };
    } catch (err) {
      return { packageId, error: err };
    }
  });

  const resolved: ResolvedSkill[] = [];
  const unresolved = new Set<string>();
  for (const entry of resolutions) {
    if ("error" in entry) {
      unresolved.add(entry.packageId);
      report.skill(`Skipped ${entry.packageId}: ${formatError(entry.error)}`);
    } else if (!entry.skill) {
      const what = source === "draft" ? "draft" : "published version";
      report.note(`Skipped ${entry.packageId}: no ${what} available.`);
    } else {
      resolved.push(entry.skill);
    }
  }

  // A slug the ledger assigns to a package that failed to resolve stays
  // reserved: handing `/appstrate:<slug>` to another skill would be a rename
  // caused by nothing but a transient error.
  const reserved = new Set<string>();
  for (const target of targets) {
    for (const [slug, managed] of Object.entries(ownedLedger(target, state, source).managed)) {
      if (unresolved.has(managed.packageId)) reserved.add(slug);
    }
  }

  const bySlug = new Map<string, PlannedSkill>();
  for (const skill of assignSlugs(resolved, reserved)) {
    bySlug.set(skill.slug, skill);
    if (skill.renamedFrom) {
      report.note(
        `Renamed ${skill.packageId} to "${skill.slug}" — "${skill.renamedFrom}" is already taken.`,
      );
    }
  }
  return { bySlug, unresolved };
}

/** Whether `claude-plugin` ended the run in the state the server describes. */
async function executePlans(
  profileName: string,
  source: SkillSource,
  plans: TargetPlan[],
  state: SyncState,
  bySlug: SkillsBySlug,
  report: Report,
): Promise<boolean> {
  const wanted = new Set(plans.flatMap((plan) => plan.write));
  const trees = await fetchTrees(profileName, source, [...wanted], bySlug, report);

  // Seeded from what is recorded: starting empty dropped the ledgers of
  // targets this run was not asked for, which then refused their own output.
  const next: SyncState = { version: STATE_VERSION, targets: { ...state.targets } };
  let pluginOk = true;
  try {
    for (const plan of plans) {
      // Carried entries are recorded BEFORE any write: a throwing write must
      // not empty the ledger, or its directories become permanently unmanaged.
      const managed = new Map<string, ManagedSkill>();
      const carried: string[] = [];
      const carry = (slug: string): void => {
        carried.push(slug);
        const entry = plan.ledger.managed[slug];
        if (entry) managed.set(slug, entry);
      };
      for (const slug of plan.keep) carry(slug);

      const fresh: string[] = [];
      for (const slug of plan.write) {
        if (trees.has(slug)) fresh.push(slug);
        // The download failed. The plugin is rebuilt in full, so "not carried
        // over" would DELETE the version that still works.
        else if (plan.present.has(slug)) carry(slug);
      }

      const outcome =
        plan.target === "claude-plugin"
          ? await applyPluginPlan(plan, fresh, carried, trees, report)
          : await applySharedPlan(plan, fresh, trees, report);
      pluginOk = pluginOk && outcome.ok;
      for (const slug of outcome.placed) managed.set(slug, ledgerEntry(bySlug.get(slug)!));

      const root = targetRoot(plan.target);
      const recorded = state.targets[plan.target];
      // A ledger under a DIFFERENT root belongs to another `HOME`, which this
      // run could not act on: leave it unless we have something to record.
      if (managed.size > 0 || !recorded || recorded.root === root) {
        next.targets[plan.target] = {
          source,
          root,
          managed: Object.fromEntries(managed),
        };
      }
    }
  } finally {
    // Written even when a target threw mid-swap: directories were already
    // replaced, and a ledger that omits them later refuses its own output.
    try {
      await writeSyncState(next);
    } catch (err) {
      report.run(`Failed to write the skills-sync state file: ${formatError(err)}`);
      pluginOk = false;
    }
  }
  return pluginOk;
}

/** Download + materialize, reporting each failure and dropping that skill. */
async function fetchTrees(
  profileName: string,
  source: SkillSource,
  slugs: string[],
  bySlug: SkillsBySlug,
  report: Report,
): Promise<Map<string, SkillTree>> {
  const trees = new Map<string, SkillTree>();
  const results = await mapWithConcurrency(slugs, MAX_CONCURRENCY, async (slug) => {
    const skill = bySlug.get(slug)!;
    try {
      const files = materializeSkill({
        slug,
        files: await fetchSkillFiles(profileName, skill, source),
      });
      return { skill, tree: { slug, files } };
    } catch (err) {
      return { skill, error: err };
    }
  });
  const decoder = new TextDecoder();
  for (const result of results) {
    if ("error" in result) {
      report.skill(`Failed ${result.skill.packageId}: ${formatError(result.error)}`);
      continue;
    }
    trees.set(result.tree.slug, result.tree);
    // Legacy artifacts predate the platform's frontmatter gate. The sync copies
    // them as authored; saying so is how the author learns why tools skip them.
    const violation = checkSkillMarkdown(decoder.decode(result.tree.files[SKILL_ENTRY]!));
    if (violation) {
      report.note(
        `Note: ${result.skill.packageId} does not pass the skill frontmatter rule (${violation.message}); Claude Code and Codex may not load it — republish it from Appstrate.`,
      );
    }
  }
  return trees;
}

/** `ok` gates the `--print-path` exit. */
interface ApplyOutcome {
  placed: Set<string>;
  ok: boolean;
}

async function applyPluginPlan(
  plan: TargetPlan,
  fresh: string[],
  carried: string[],
  trees: Map<string, SkillTree>,
  report: Report,
): Promise<ApplyOutcome> {
  const root = targetRoot(plan.target);
  if (fresh.length === 0 && plan.removed.length === 0 && (await pluginTreeMatches(root, carried))) {
    return { placed: new Set(), ok: true };
  }
  try {
    const failures = await writePluginTree(
      fresh.map((slug) => trees.get(slug)!),
      carried,
      root,
    );
    const placed = new Set(fresh);
    for (const failure of failures) {
      report.skill(`Failed to write ${plan.target}/${failure.slug}: ${formatError(failure.error)}`);
      placed.delete(failure.slug);
    }
    return { placed, ok: true };
  } catch (err) {
    // The SWAP failed, so the plugin on disk is not what the server describes.
    report.run(`Failed to write ${plan.target}: ${formatError(err)}`);
    return { placed: new Set(), ok: false };
  }
}

/** `ok` is always true: a passenger root never costs Claude Code its plugin. */
async function applySharedPlan(
  plan: TargetPlan,
  fresh: string[],
  trees: Map<string, SkillTree>,
  report: Report,
): Promise<ApplyOutcome> {
  const root = targetRoot(plan.target);
  const placed = new Set<string>();
  for (const slug of fresh) {
    try {
      await writeSharedSkill(plan.target, trees.get(slug)!, root);
      placed.add(slug);
    } catch (err) {
      report.skill(`Failed to write ${plan.target}/${slug}: ${formatError(err)}`);
    }
  }
  // Guarded one by one so a stubborn leftover does not strand the deletions
  // behind it. The entry leaves the ledger either way.
  for (const slug of plan.removed) {
    try {
      await removeManagedDir(skillDir(plan.target, slug));
    } catch (err) {
      report.skill(`Failed to remove ${plan.target}/${slug}: ${formatError(err)}`);
    }
  }
  return { placed, ok: true };
}

function ledgerEntry(skill: PlannedSkill): ManagedSkill {
  return { packageId: skill.packageId, version: skill.version, integrity: skill.integrity };
}

function reportPlans(plans: TargetPlan[], sink: LineSink): void {
  for (const plan of plans) {
    // New versus refreshed comes from the ledger, where that fact already lives.
    const glyph = (slug: string): string => (plan.ledger.managed[slug] ? "~" : "+");
    const added = plan.write.filter((slug) => glyph(slug) === "+").length;
    sink.write(
      `${plan.target.padEnd(14)} ${targetRoot(plan.target)}` +
        `  +${added} ~${plan.write.length - added} =${plan.keep.length} -${plan.removed.length}\n`,
    );
    for (const slug of plan.write) sink.write(`  ${glyph(slug)} ${slug}\n`);
    for (const slug of plan.removed) sink.write(`  - ${slug}\n`);
  }
}

function uniqueTargets(requested: SyncTarget[] | undefined): SyncTarget[] {
  if (!requested || requested.length === 0) return ["claude-plugin"];
  return [...new Set(requested)];
}
