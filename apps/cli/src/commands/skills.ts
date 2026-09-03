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
import { resolveActiveProfile, requireLoggedIn } from "../lib/config.ts";
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
  skillDir,
  targetRoot,
  writePluginTree,
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
  requireLoggedIn(profileName, profile, io);
  if (!profile.orgId) {
    io.stderr.write("No organization pinned. Run: appstrate org switch\n");
    io.exit(1);
  }
  if (!profile.spaceId) {
    io.stderr.write("No space pinned. Run: appstrate space switch\n");
    io.exit(1);
  }

  // Two grades, because `--print-path` treats them differently: a skill
  // failure is information, a run failure means the plugin on disk is not what
  // the server describes.
  let skillFailures = 0;
  let runFailures = 0;
  const failSkill = (message: string): void => {
    skillFailures += 1;
    io.stderr.write(`${message}\n`);
  };
  const failRun = (message: string): void => {
    runFailures += 1;
    io.stderr.write(`${message}\n`);
  };
  /** Worth telling the user, not worth an exit code. */
  const note = (message: string): void => {
    io.stderr.write(`${message}\n`);
  };
  let pluginOk = !targets.includes("claude-plugin");

  try {
    await withSyncLock(async () => {
      const { state, corrupt } = await readSyncState();
      if (corrupt) {
        io.stderr.write(
          "Sync state could not be used and has been ignored — this run re-materializes everything.\n",
        );
      }

      const catalogue = await resolveAll(profileName, source, state, targets, io, failSkill);
      const plans = await Promise.all(
        targets.map((target) => diffTarget(target, catalogue, state, source)),
      );
      for (const plan of plans) {
        for (const slug of plan.blocked) {
          failSkill(
            `Skipped ${catalogue.bySlug.get(slug)!.packageId} on ${plan.target}: ${skillDir(plan.target, slug)} exists and is not managed by appstrate — remove or rename it`,
          );
        }
      }

      if (opts.dryRun) {
        reportPlans(plans, io.stdout);
        return;
      }
      pluginOk = await executePlans(
        profileName,
        source,
        plans,
        state,
        catalogue.bySlug,
        failSkill,
        failRun,
        note,
      );
      if (!printPath) reportPlans(plans, io.stdout);
    });
  } catch (err) {
    failRun(formatError(err));
    pluginOk = false;
  }

  const failed = printPath ? runFailures > 0 || !pluginOk : runFailures + skillFailures > 0;
  if (!failed && printPath) io.stdout.write(`${targetRoot("claude-plugin")}\n`);
  if (failed) io.exit(1);
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
  io: CommandIO,
  fail: (message: string) => void,
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
      fail(`Skipped ${entry.packageId}: ${formatError(entry.error)}`);
    } else if (!entry.skill) {
      const what = source === "draft" ? "draft" : "published version";
      io.stderr.write(`Skipped ${entry.packageId}: no ${what} available.\n`);
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
      io.stderr.write(
        `Renamed ${skill.packageId} to "${skill.slug}" — "${skill.renamedFrom}" is already taken.\n`,
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
  failSkill: (message: string) => void,
  failRun: (message: string) => void,
  note: (message: string) => void,
): Promise<boolean> {
  const wanted = new Set(plans.flatMap((plan) => plan.write));
  const trees = await fetchTrees(profileName, source, [...wanted], bySlug, failSkill, note);

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
          ? await applyPluginPlan(plan, fresh, carried, trees, failSkill, failRun)
          : await applySharedPlan(plan, fresh, trees, failSkill);
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
          managed: Object.fromEntries([...managed].sort(([a], [b]) => a.localeCompare(b))),
        };
      }
    }
  } finally {
    // Written even when a target threw mid-swap: directories were already
    // replaced, and a ledger that omits them later refuses its own output.
    try {
      await writeSyncState(next);
    } catch (err) {
      failRun(`Failed to write the skills-sync state file: ${formatError(err)}`);
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
  failSkill: (message: string) => void,
  note: (message: string) => void,
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
      failSkill(`Failed ${result.skill.packageId}: ${formatError(result.error)}`);
      continue;
    }
    trees.set(result.tree.slug, result.tree);
    // Legacy artifacts predate the platform's frontmatter gate. The sync copies
    // them as authored; saying so is how the author learns why tools skip them.
    const violation = checkSkillMarkdown(decoder.decode(result.tree.files[SKILL_ENTRY]!));
    if (violation) {
      note(
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
  failSkill: (message: string) => void,
  failRun: (message: string) => void,
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
      failSkill(`Failed to write ${plan.target}/${failure.slug}: ${formatError(failure.error)}`);
      placed.delete(failure.slug);
    }
    return { placed, ok: true };
  } catch (err) {
    // The SWAP failed, so the plugin on disk is not what the server describes.
    failRun(`Failed to write ${plan.target}: ${formatError(err)}`);
    return { placed: new Set(), ok: false };
  }
}

/** `ok` is always true: a passenger root never costs Claude Code its plugin. */
async function applySharedPlan(
  plan: TargetPlan,
  fresh: string[],
  trees: Map<string, SkillTree>,
  failSkill: (message: string) => void,
): Promise<ApplyOutcome> {
  const root = targetRoot(plan.target);
  const placed = new Set<string>();
  for (const slug of fresh) {
    try {
      await writeSharedSkill(plan.target, trees.get(slug)!, root);
      placed.add(slug);
    } catch (err) {
      failSkill(`Failed to write ${plan.target}/${slug}: ${formatError(err)}`);
    }
  }
  // Guarded one by one so a stubborn leftover does not strand the deletions
  // behind it. The entry leaves the ledger either way.
  for (const slug of plan.removed) {
    try {
      await removeManagedDir(skillDir(plan.target, slug));
    } catch (err) {
      failSkill(`Failed to remove ${plan.target}/${slug}: ${formatError(err)}`);
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
