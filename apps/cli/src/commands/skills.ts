// SPDX-License-Identifier: Apache-2.0

/**
 * `appstrate skills sync` — the skills of every space this profile is a member
 * of, as Agent Skills directories, run by a *machine*: a marketplace `command`
 * source re-runs it once per session in the background. So `--print-path` writes
 * exactly one stdout line and only on success, and a per-skill failure must
 * NOT fail the process — Claude Code discards a run that exits non-zero, which
 * would throw away a correct plugin over a skill that was never in it.
 */

import { mapWithConcurrency } from "@appstrate/core/map-with-concurrency";
import { resolveActiveProfile, syncSpaceIds, type Profile } from "../lib/config.ts";
import { ApiError } from "../lib/api.ts";
import { listSpaces, resolveSpaceRef, type Space } from "../lib/spaces.ts";
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
  syncContext,
  sameContext,
  type SyncContext,
  STATE_VERSION,
  writeSyncState,
  type ManagedSkill,
  type SyncState,
} from "../lib/skills-sync/state.ts";
import {
  pluginFixedFiles,
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
  space?: string[];
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
    await withSyncLock(
      async () => {
        const { profileName, profile } = await resolveActiveProfile(opts.profile);
        const gap = connectionGap(profileName, profile);
        if (gap && !printPath) throw new Error(`${gap.problem}. Run: ${gap.remedy}`);
        const { state, corrupt } = await readSyncState();
        if (corrupt) {
          io.stderr.write(
            "Sync state could not be used and has been ignored — this run re-materializes everything.\n",
          );
        }

        if (gap) {
          pluginOk = await bootstrapPlugin(gap, state, report);
          return;
        }

        const context = syncContext(profileName, profile!);
        // The pin is checked here although it is NOT part of the context: it is
        // what `fixedFiles` was computed from at the start of the run, so a swap
        // after it moved would commit a `.mcp.json` naming the previous space.
        // The next run rewrites that file without treating anything as a switch.
        const validate = async (): Promise<void> => {
          const current = await resolveActiveProfile(opts.profile);
          if (
            !current.profile ||
            !sameContext(context, syncContext(current.profileName, current.profile)) ||
            current.profile.spaceId !== profile!.spaceId ||
            JSON.stringify(current.profile.syncSpaces) !== JSON.stringify(profile!.syncSpaces)
          ) {
            throw new Error("Active sync context changed; run skills sync again.");
          }
        };
        const spaceIds = await selectedSpaces(profileName, profile!, opts.space, report);
        const catalogue = await resolveAll(
          profileName,
          source,
          state,
          targets,
          report,
          spaceIds,
          context,
        );
        const plans = await Promise.all(
          targets.map((target) => diffTarget(target, catalogue, state, source, context)),
        );
        if (plans.some((plan) => plan.contextChanged) && catalogue.unresolved.size > 0) {
          throw new Error(
            "Could not resolve the new context completely; previous installation preserved.",
          );
        }
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
        const fixedFiles = pluginFixedFiles({
          instance: profile!.instance,
          orgId: profile!.orgId!,
          spaceId: profile!.spaceId!,
        });
        pluginOk = await executePlans(
          profileName,
          source,
          plans,
          state,
          catalogue.bySlug,
          fixedFiles,
          report,
          context,
          validate,
        );
        if (!printPath) reportPlans(plans, io.stdout);
      },
      { io },
    );
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
  report: Report,
): Promise<boolean> {
  const message = `${gap.problem}. Run: ${gap.remedy}`;
  // Connected syncs record a target even with no skills. Setup never records
  // one: a lost profile must preserve an empty plugin's working MCP server too.
  if (state.targets["claude-plugin"]?.root === targetRoot("claude-plugin")) {
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
 * List the selected spaces' skills, pin each to an artifact, and assign
 * directory names. A skill with no published version is a note, not a failure.
 */
async function resolveAll(
  profileName: string,
  source: SkillSource,
  state: SyncState,
  targets: SyncTarget[],
  report: Report,
  spaceIds: string[],
  context: SyncContext,
): Promise<Catalogue> {
  // A package is an ORG row that `space_packages` attributes to zero or more
  // spaces, so the same skill is normally listed by several of them. It is
  // downloaded once, from the first space that listed it — and `spaceIds` order
  // decides which, so the listings run concurrently but merge in input order.
  const listings = await mapWithConcurrency(spaceIds, MAX_CONCURRENCY, (spaceId) =>
    listSyncableSkills(profileName, spaceId),
  );
  const origins = new Map<string, string>();
  spaceIds.forEach((spaceId, index) => {
    for (const packageId of listings[index]!) {
      if (!origins.has(packageId)) origins.set(packageId, spaceId);
    }
  });
  const packageIds = [...origins.keys()].sort();
  const resolutions = await mapWithConcurrency(packageIds, MAX_CONCURRENCY, async (packageId) => {
    try {
      return {
        packageId,
        skill: await resolveSkill(profileName, packageId, source, origins.get(packageId)),
      };
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
    for (const [slug, managed] of Object.entries(
      ownedLedger(target, state, source, context).managed,
    )) {
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
  fixedFiles: Record<string, Uint8Array>,
  report: Report,
  context: SyncContext,
  validate: () => Promise<void>,
): Promise<boolean> {
  const wanted = new Set(plans.flatMap((plan) => plan.write));
  const trees = await fetchTrees(profileName, source, [...wanted], bySlug, report);
  if (plans.some((plan) => plan.contextChanged) && trees.size !== wanted.size) {
    throw new Error(
      "Could not download the new context completely; previous installation preserved.",
    );
  }
  await validate();

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
          ? await applyPluginPlan(plan, fresh, carried, trees, fixedFiles, report, validate)
          : await applySharedPlan(plan, fresh, trees, report, validate);
      pluginOk = pluginOk && outcome.ok;
      if (!outcome.ok) continue;
      for (const slug of outcome.retained ?? []) carry(slug);
      for (const slug of outcome.placed) managed.set(slug, ledgerEntry(bySlug.get(slug)!));

      const root = targetRoot(plan.target);
      const recorded = state.targets[plan.target];
      // A ledger under a DIFFERENT root belongs to another `HOME`, which this
      // run could not act on: leave it unless we have something to record.
      if (managed.size > 0 || !recorded || recorded.root === root) {
        next.targets[plan.target] = {
          source,
          context,
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
  retained?: Set<string>;
  placed: Set<string>;
  ok: boolean;
}

async function applyPluginPlan(
  plan: TargetPlan,
  fresh: string[],
  carried: string[],
  trees: Map<string, SkillTree>,
  fixedFiles: Record<string, Uint8Array>,
  report: Report,
  validate: () => Promise<void>,
): Promise<ApplyOutcome> {
  const root = targetRoot(plan.target);
  if (
    fresh.length === 0 &&
    plan.removed.length === 0 &&
    (await pluginTreeMatches(root, carried, fixedFiles))
  ) {
    return { placed: new Set(), ok: true };
  }
  try {
    const failures = await writePluginTree(
      fresh.map((slug) => trees.get(slug)!),
      carried,
      root,
      fixedFiles,
      plan.contextChanged,
      validate,
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
  validate: () => Promise<void>,
): Promise<ApplyOutcome> {
  const root = targetRoot(plan.target);
  const placed = new Set<string>();
  const retained = new Set<string>();
  for (const slug of fresh) {
    try {
      await writeSharedSkill(plan.target, trees.get(slug)!, root, validate);
      placed.add(slug);
    } catch (err) {
      if (plan.ledger.managed[slug]) retained.add(slug);
      report.skill(`Failed to write ${plan.target}/${slug}: ${formatError(err)}`);
    }
  }
  // Guarded one by one so a stubborn leftover does not strand the deletions
  // behind it. Failed removals retain ownership so cleanup can be retried.
  for (const slug of plan.removed) {
    try {
      await validate();
      await removeManagedDir(skillDir(plan.target, slug));
    } catch (err) {
      retained.add(slug);
      report.skill(`Failed to remove ${plan.target}/${slug}: ${formatError(err)}`);
    }
  }
  return { placed, retained, ok: true };
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

/** What the list route requires of the caller in the space it is asked about. */
const SKILLS_READ = "skills:read";

/**
 * Can this space actually SUPPLY skills to this profile?
 *
 * `GET /api/spaces` answers what the caller may KNOW about, which is wider
 * than what it may USE: `isSpaceVisibleTo` also lists a `closed` space an org
 * member has not joined, so they can ask to be added, and it comes back with
 * `access: "none"`. Naming such a space in `X-Space-Id` is refused with 403
 * `not_a_space_member`; a member whose space role does not grant `skills:read`
 * is refused by the list route itself. Either refusal fails the WHOLE sync
 * (`report.run` → exit 1, and under `--print-path` Claude Code then discards
 * the run and keeps the stale plugin), so one space nobody joined must never
 * become a source.
 */
function suppliesSkills(space: Space): boolean {
  return space.access === "member" && space.permissions.includes(SKILLS_READ);
}

/** Why `suppliesSkills` said no — the half of the answer a user can act on. */
function unusableReason(space: Space): string {
  return space.access === "member"
    ? `your role there does not grant ${SKILLS_READ}`
    : "you are not a member of it";
}

/**
 * The spaces this profile reaches, or `null` when the organization no longer
 * lets it reach any.
 *
 * `GET /api/spaces` answers 403 to a caller the pinned organization does not
 * admit: `orgContext` refuses one with no membership row ("You are not a member
 * of this organization"), and `requirePermission("spaces", "read")` refuses one
 * whose org role cannot read the catalog. Either way the server has stated that
 * this profile draws no skills from this organization any more — a REVOCATION,
 * which the sync must APPLY, not a fault to retry. Reported as a fault it exits
 * 1, and under `--print-path` Claude Code then discards the run and keeps
 * serving the stale plugin, so an offboarded machine kept every one of that
 * organization's skills forever (issue #1362).
 *
 * Only 403 is a statement about this profile's grants. A 401 is about the
 * SESSION — `apiFetch` turns it into a re-login `AuthError` after a refresh
 * attempt, and a lapsed login must never take working skills away (same reason
 * `bootstrapPlugin` keeps an existing plugin) — and a 5xx or a network error is
 * a fault that leaves the tree untouched.
 */
async function reachableSpaces(
  profileName: string,
  profile: Profile,
  report: Report,
): Promise<Space[] | null> {
  try {
    return await listSpaces(profileName);
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 403) throw err;
    report.note(
      `Organization "${profile.orgId}" no longer grants this profile access to its spaces (403) — removing every skill synced from it. Run: appstrate org switch`,
    );
    return null;
  }
}

/**
 * Which spaces supply skills. The default is every space this profile is a
 * MEMBER of with `skills:read` there: being granted a space is what puts its
 * skills on the machine, and losing one is what takes them off again — neither
 * should need a second, manual step. `GET /api/spaces` answers per principal
 * (`listSpacesForPrincipal`), so the grant is the whole mechanism — but it also
 * lists spaces one may only ask to join, which `suppliesSkills` drops.
 *
 * `--space` and `syncSpaces` NARROW that set; they never widen it.
 */
async function selectedSpaces(
  profileName: string,
  profile: Profile,
  explicit: string[] | undefined,
  report: Report,
): Promise<string[]> {
  const spaces = await reachableSpaces(profileName, profile, report);
  if (!spaces) {
    // Typed just now, so it gets immediate feedback rather than a silent drop —
    // the same rule the explicit branch below applies to an unusable space.
    if (explicit)
      throw new Error(
        "Cannot select spaces: this organization no longer grants this profile access to them. Run: appstrate org switch",
      );
    // Otherwise the revocation stands on its own: no space supplies skills any
    // more, so the ordinary removal plan takes every one of them off the disk.
    return [];
  }
  // Skill sources no longer depend on the pin, so a pin that died would sync
  // clean and leave `.mcp.json` naming a space the server will refuse. Nothing
  // else notices any more: say it here, where the space list is already in hand.
  // Listed-but-not-joined is the same refusal as absent — the MCP request sends
  // the header either way — so membership, not presence in the list, is the test.
  const pinned = spaces.find((space) => space.id === profile.spaceId);
  if (profile.spaceId && (!pinned || pinned.access === "none"))
    report.note(
      `Pinned space "${profile.spaceId}" is not accessible in the active organization — the plugin's MCP server will be refused. Run: appstrate space switch`,
    );
  if (explicit) {
    const chosen = explicit.map((ref) => explicitSpace(spaces, ref));
    // Typed just now, so it gets immediate feedback rather than a silent drop.
    for (const space of chosen) {
      if (!suppliesSkills(space))
        throw new Error(
          `Space "${space.name}" (${space.id}) cannot supply skills: ${unusableReason(space)}.`,
        );
    }
    return [...new Set(chosen.map((space) => space.id))];
  }
  const configured = syncSpaceIds(profileName, profile);
  if (!configured) return spaces.filter(suppliesSkills).map((space) => space.id);
  // A stored list outlives the grants it was written against. An id this
  // profile no longer reaches is dropped with a note, not a failure: losing
  // access is a decision elsewhere, and it must not break the other spaces.
  const listed = new Map(spaces.map((space) => [space.id, space]));
  const kept: string[] = [];
  for (const id of configured) {
    const space = listed.get(id);
    if (space && suppliesSkills(space)) {
      kept.push(id);
      continue;
    }
    report.note(
      space
        ? `Configured sync space "${id}" cannot supply skills — ${unusableReason(space)}; skipped.`
        : `Configured sync space "${id}" is not accessible in the active organization — skipped.`,
    );
  }
  return [...new Set(kept)];
}

/** A flag is typed by hand, so it takes an ID or an unambiguous exact name. */
function explicitSpace(spaces: Space[], ref: string): Space {
  const trimmed = ref.trim();
  const byId = spaces.find((space) => space.id === trimmed);
  if (byId) return byId;
  const named = spaces.filter((space) => space.name === trimmed);
  if (named.length > 1) throw new Error(`Ambiguous space name "${ref}": use a space ID.`);
  // Nothing matched: `resolveSpaceRef` only throws here, and its message lists
  // the spaces this profile can see.
  return named[0] ?? resolveSpaceRef(spaces, trimmed);
}
