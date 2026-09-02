// SPDX-License-Identifier: Apache-2.0

/**
 * `appstrate skills sync` — materialize the pinned space's skills as Agent
 * Skills directories on this machine.
 *
 * The command exists to be run by a *machine*. Claude Code's plugin
 * marketplaces accept `source: "command"`: a locally installed tool prints the
 * path of a directory holding a complete plugin, and Claude Code re-runs that
 * command once per session in the background, reinstalling and reloading the
 * plugin when the directory's content hash changes. That is the entire
 * auto-sync mechanism — no hook, no daemon, no server change — and it is what
 * the rules below answer to:
 *
 *  - **`--print-path` writes exactly one line to stdout, and only on success.**
 *    Claude Code parses stdout as the path and discards a run that exits
 *    non-zero, so a per-skill failure must NOT fail the process: it would
 *    throw away a correct plugin over a skill that was never going to be in
 *    it. Only a whole-run failure (auth, the catalogue call, the plugin swap,
 *    the ledger) is worth the exit code there.
 *  - **Never prompt, never assume a TTY.** The background run has no terminal.
 *  - **Byte-identical output for identical inputs.** The plugin's version IS
 *    the hash of its contents.
 *  - **One run at a time.** Two sessions opening together would race the
 *    atomic swaps and the ledger, so the body holds a cross-process lock.
 *
 * `--target codex` and `--target claude-user` write the same skill directories
 * into `~/.agents/skills/` and `~/.claude/skills/`. Those roots are SHARED
 * with hand-written skills, so a destination the ledger does not claim is
 * never written and never deleted — it is reported and skipped.
 *
 * Structure mirrors `./space.ts`: options in, `CommandIO` sink last, no direct
 * process-stream writes.
 */

import { mapWithConcurrency } from "@appstrate/core/map-with-concurrency";
import { resolveActiveProfile, requireLoggedIn } from "../lib/config.ts";
import { DEFAULT_IO, type CommandIO } from "../lib/io.ts";
import { formatError } from "../lib/ui.ts";
import { materializeSkill } from "../lib/skills-sync/materialize.ts";
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
  /** Repeatable `--target`. Empty / absent means `["claude-plugin"]`. */
  target?: SyncTarget[];
  /** `--source`. Defaults to `published` (D1). */
  source?: SkillSource;
  /** `--print-path`: stdout carries the plugin directory and nothing else. */
  printPath?: boolean;
  /** `--dry-run`: report the plan, touch nothing. */
  dryRun?: boolean;
}

/** A one-line sink — `io.stdout` or `io.stderr`, chosen per output mode. */
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
    // A dry run builds nothing, so the path it would print names a directory
    // that may not exist — and a marketplace `command` source reading it would
    // install an empty or stale plugin while the run reported success.
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

  // Two grades of failure, because `--print-path` treats them differently: a
  // skill failure is information, a run failure means the plugin on disk is
  // not what the server describes. Cashed in AFTER the `try`, so an `io.exit`
  // that a test sink turns into a throw is not swallowed here.
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
  // Vacuously true when no plugin was asked for; only consulted under
  // `--print-path`.
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
      );
      if (!printPath) reportPlans(plans, io.stdout);
    });
  } catch (err) {
    // Anything reaching here aborted the run before every target was settled.
    failRun(formatError(err));
    pluginOk = false;
  }

  // One verdict, one place.
  const failed = printPath ? runFailures > 0 || !pluginOk : runFailures + skillFailures > 0;
  if (!failed && printPath) io.stdout.write(`${targetRoot("claude-plugin")}\n`);
  if (failed) io.exit(1);
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/**
 * List the space's skills, pin each to an artifact, and assign directory
 * names. A skill with no published version (or no draft) is a note on stderr,
 * not a failure — that is an ordinary state for a package being written.
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

  // A slug the ledger already assigns to a package that failed to resolve
  // stays reserved for it: its directory is still on disk, so handing that
  // `/appstrate:<slug>` command to another skill would be a rename caused by
  // nothing but a transient error.
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

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/** Whether the `claude-plugin` tree ended the run in the state the server describes. */
async function executePlans(
  profileName: string,
  source: SkillSource,
  plans: TargetPlan[],
  state: SyncState,
  bySlug: SkillsBySlug,
  failSkill: (message: string) => void,
  failRun: (message: string) => void,
): Promise<boolean> {
  // One download per skill, however many targets want it: the materialized
  // bytes are identical everywhere, only the destination differs.
  const wanted = new Set(plans.flatMap((plan) => plan.write));
  const trees = await fetchTrees(profileName, source, [...wanted], bySlug, failSkill);

  // Seeded from what is already recorded: this run touches only the targets it
  // was asked for, and `appstrate skills sync` with no `--target` is the
  // documented first example. Starting empty dropped the `codex` /
  // `claude-user` ledgers on every plugin-only run, so the next marketplace
  // run found every directory it had itself written unmanaged — and refused
  // them, permanently.
  const next: SyncState = { version: STATE_VERSION, targets: { ...state.targets } };
  let pluginOk = true;
  try {
    for (const plan of plans) {
      // Carried entries are recorded BEFORE any write. A write that throws
      // must not empty the ledger: the directories it claims are already on
      // disk, and forgetting them turns every one of them into "unmanaged" on
      // the next run — permanently unwritable and undeletable.
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
        // The download failed. Keep whatever is already on disk: the plugin is
        // rebuilt in full, so "not carried over" means the previously working
        // version is DELETED because the new one could not be fetched.
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
      // A ledger recorded under a DIFFERENT root belongs to another `HOME`
      // (cron, launchd, a devcontainer). This run could not act on it, so it
      // has nothing to say about it: overwrite only once there is something of
      // our own to record, and otherwise leave the other root's entry alone so
      // a later run back under it still owns its directories.
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
    // replaced, and a ledger that does not mention them is a ledger that will
    // later refuse to manage — or silently overwrite — its own output.
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
): Promise<Map<string, SkillTree>> {
  const trees = new Map<string, SkillTree>();
  const results = await mapWithConcurrency(slugs, MAX_CONCURRENCY, async (slug) => {
    const skill = bySlug.get(slug)!;
    try {
      const files = await fetchSkillFiles(profileName, skill, source);
      const materialized = materializeSkill({
        slug,
        files,
        manifestDescription: skill.manifestDescription,
      });
      return { skill, tree: { slug, files: materialized } };
    } catch (err) {
      return { skill, error: err };
    }
  });
  for (const result of results) {
    if ("error" in result) {
      failSkill(`Failed ${result.skill.packageId}: ${formatError(result.error)}`);
    } else {
      trees.set(result.tree.slug, result.tree);
    }
  }
  return trees;
}

/** What one target's write pass achieved. `ok` gates the `--print-path` exit. */
interface ApplyOutcome {
  placed: Set<string>;
  ok: boolean;
}

/**
 * Rebuild and swap the whole plugin tree — or skip when it is provably already
 * what this run would produce.
 */
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
    // The SWAP failed: nothing was published, so the plugin on disk is not
    // what the server describes and `--print-path` must not report success.
    failRun(`Failed to write ${plan.target}: ${formatError(err)}`);
    return { placed: new Set(), ok: false };
  }
}

/**
 * `codex` / `claude-user`: one swap per skill, each failing on its own.
 *
 * `ok` is always true — a passenger target says nothing about the plugin, so
 * an anomaly in `~/.agents/skills` never costs Claude Code a plugin that was
 * written correctly.
 */
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
  // Each removal is guarded on its own: `removeManagedDir` refuses a path that
  // is no longer a directory, and one stubborn leftover must not strand the
  // deletions queued behind it. The entry is dropped from the ledger either
  // way — continuing to claim something we will not touch is worse.
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

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function reportPlans(plans: TargetPlan[], sink: LineSink): void {
  for (const plan of plans) {
    // New versus refreshed comes from the ledger, which is where that fact
    // already lives — no second bucket needed to carry a report glyph.
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Dedupe repeated `--target` while preserving the order the user gave. */
function uniqueTargets(requested: SyncTarget[] | undefined): SyncTarget[] {
  if (!requested || requested.length === 0) return ["claude-plugin"];
  return [...new Set(requested)];
}
