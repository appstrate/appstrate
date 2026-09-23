// SPDX-License-Identifier: Apache-2.0

/**
 * Server half of `appstrate packages sync`. No bulk endpoint exists, so it is one
 * list call, one resolution call per skill, and downloads only for what
 * changed; concurrency is capped because the package routes are rate limited.
 */

import { apiFetch, apiFetchRaw, apiList, ApiError, problemFields } from "../api.ts";
import { encodePackageIdPath, parseScopedName } from "@appstrate/core/naming";
import { extractSkillMeta } from "@appstrate/core/validation";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { draftRefusal, fetchPackageDefinition } from "../package-definition.ts";
import { collisionSlug, SKILL_ENTRY, skillSlug } from "./materialize.ts";
import {
  emptyTargetState,
  STATE_VERSION,
  sameContext,
  type SyncContext,
  type SyncState,
  type TargetState,
} from "./state.ts";
import { destinationExists, skillDir, targetRoot, type SyncTarget } from "./targets.ts";

export const MAX_CONCURRENCY = 8;

export type SkillSource = TargetState["source"];

class SkillSyncError extends Error {
  constructor(
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "SkillSyncError";
  }
}

/**
 * `--source draft` NAMES the working copy, and every route that honours the
 * selector — the package detail, the file index and the draft archive —
 * reserves that act to whoever may write the package. One remedy for each of
 * the three refusals: a reader who hits the earliest one must not get a
 * thinner message than one whose grant is revoked mid-sync.
 */
const DRAFT_REMEDY = "Sync the published artifact with `--source published`.";

interface SkillListRow {
  id: string;
  source?: string;
}

export interface ResolvedSkill {
  packageId: string;
  spaceId?: string;
  version: string;
  /** SRI for a published artifact, ETag + `lock_version` for a draft. */
  integrity: string;
  /** Frontmatter `name` of the skill's `SKILL.md`, empty when it has none. */
  frontmatterName: string;
}

export interface PlannedSkill extends ResolvedSkill {
  slug: string;
  /** Set when a collision forced the `<scope>-<name>` fallback (D4). */
  renamedFrom?: string;
}

/**
 * Sorted by package id, which is what makes collision resolution reproducible
 * rather than server-order dependent. System packages are the platform's.
 *
 * The index listing IS the ACTIVE set, not merely the placed one. Activation is
 * what a space OFFERS — a skill switched off there is one somebody decided the
 * space would not use, and writing it into the local Claude Code checkout anyway
 * would hand the switch no meaning outside the dashboard. A skill switched back
 * on reappears on the next sync, because the sync reads this list every time.
 */
export async function listSyncableSkills(profileName: string, spaceId?: string): Promise<string[]> {
  const rows = await apiList<SkillListRow>(profileName, "/api/packages/skills", {
    spaceId,
  });
  return rows
    .filter((row) => row.source !== "system" && typeof row.id === "string" && row.id.length > 0)
    .map((row) => row.id)
    .sort();
}

/** `null` means no published version — a note on stderr, not a failure. */
export async function resolveSkill(
  profileName: string,
  packageId: string,
  source: SkillSource,
  spaceId?: string,
): Promise<ResolvedSkill | null> {
  return source === "published"
    ? resolvePublished(profileName, packageId, spaceId)
    : resolveDraft(profileName, packageId, spaceId);
}

async function resolvePublished(
  profileName: string,
  packageId: string,
  spaceId?: string,
): Promise<ResolvedSkill | null> {
  interface VersionDetail {
    version?: unknown;
    integrity?: unknown;
    content?: unknown;
  }
  let detail: VersionDetail;
  try {
    detail = await apiFetch<VersionDetail>(
      profileName,
      `/api/packages/skills/${encodePackageIdPath(packageId)}/versions/latest`,
      { spaceId },
    );
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
  if (typeof detail.version !== "string" || typeof detail.integrity !== "string") {
    throw new SkillSyncError(
      `Version detail for ${packageId} is missing version or integrity`,
      "The instance is running an incompatible API version.",
    );
  }
  return {
    packageId,
    ...(spaceId ? { spaceId } : {}),
    version: detail.version,
    integrity: detail.integrity,
    frontmatterName: frontmatterNameOf(detail.content),
  };
}

async function resolveDraft(
  profileName: string,
  packageId: string,
  spaceId?: string,
): Promise<ResolvedSkill | null> {
  interface DraftDetail {
    content?: unknown;
    lock_version?: unknown;
  }
  let detail: DraftDetail;
  try {
    detail = await apiFetch<DraftDetail>(
      profileName,
      `/api/packages/skills/${encodePackageIdPath(packageId)}?version=draft`,
      { spaceId },
    );
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.status === 404) return null;
      // This request names `?version=draft` as well, so for a non-author it is
      // the FIRST one refused — before `/files` below ever runs. Relaying the
      // raw 403 here is what would lose the actionable refusal entirely.
      if (problemFields(err.body).code === "draft_not_writable") {
        throw draftRefusal(packageId, "skill", DRAFT_REMEDY);
      }
      throw err;
    }
    throw err;
  }
  // A draft has no immutable digest: the change token is the index ETag and
  // `lock_version`, the two values that DO move with its content.
  // BOTH requests name `?version=draft`, never leaving it to the route's
  // default: omitted, detail and file routes alike serve the definition the
  // DETAIL page renders — the published version for anyone who cannot write
  // the package — and the sync would read one definition's metadata against
  // the other's bytes, then write published bytes into a ledger that calls
  // them a draft.
  const res = await apiFetchRaw(
    profileName,
    `/api/packages/${encodePackageIdPath(packageId)}/files?version=draft`,
    { spaceId },
  );
  if (!res.ok) {
    const problem = problemFields(await res.json().catch(() => undefined));
    if (problem.code === "draft_not_writable") {
      throw draftRefusal(packageId, "skill", DRAFT_REMEDY);
    }
    throw new SkillSyncError(
      `Draft file index for ${packageId} failed: ${problem.detail ?? `HTTP ${res.status} ${res.statusText}`}`,
      "Re-run without `--source draft`, or check that the skill still exists.",
    );
  }
  const etag = res.headers.get("etag") ?? "";
  const lock = typeof detail.lock_version === "number" ? String(detail.lock_version) : "0";
  return {
    packageId,
    ...(spaceId ? { spaceId } : {}),
    version: "draft",
    integrity: `draft:${lock}:${etag}`,
    frontmatterName: frontmatterNameOf(detail.content),
  };
}

/**
 * Input order decides collisions, and callers pass a list sorted by package id,
 * so the assignment never depends on request timing.
 */
export function assignSlugs(
  resolved: ResolvedSkill[],
  reserved: ReadonlySet<string> = new Set(),
): PlannedSkill[] {
  // `reserved` = catalogued packages whose resolution failed: their directories
  // are on disk, so a transient 500 must not reassign `/appstrate:<slug>`.
  const taken = new Set<string>(reserved);
  const planned: PlannedSkill[] = [];
  for (const skill of resolved) {
    const parsed = parseScopedName(skill.packageId);
    const preferred = skillSlug(skill.frontmatterName, parsed?.name ?? skill.packageId);
    if (!taken.has(preferred)) {
      taken.add(preferred);
      planned.push({ ...skill, slug: preferred });
      continue;
    }
    const fallback = collisionSlug(skill.packageId, taken);
    taken.add(fallback);
    planned.push({ ...skill, slug: fallback, renamedFrom: preferred });
  }
  return planned;
}

/**
 * Both sources are one archive (`../package-definition.ts`); the published one
 * is checked against `X-Integrity` before anything is unpacked. A draft archive
 * read after resolution may be newer than the token recorded for it — the next
 * sync then sees the token move and fetches again, never the reverse.
 */
export function fetchSkillFiles(
  profileName: string,
  skill: ResolvedSkill,
  source: SkillSource,
): Promise<Record<string, Uint8Array>> {
  return fetchPackageDefinition(
    profileName,
    source === "published"
      ? {
          packageId: skill.packageId,
          spaceId: skill.spaceId,
          source,
          version: skill.version,
          integrity: skill.integrity,
        }
      : {
          packageId: skill.packageId,
          type: "skill",
          spaceId: skill.spaceId,
          source,
          refusalRemedy: DRAFT_REMEDY,
        },
  );
}

function frontmatterNameOf(content: unknown): string {
  return typeof content === "string" ? extractSkillMeta(content).name : "";
}

/** Slug assignment is global, so every plan indexes into the same map. */
export type SkillsBySlug = ReadonlyMap<string, PlannedSkill>;

export interface TargetPlan {
  target: SyncTarget;
  ledger: TargetState;
  write: string[];
  /** Carried over untouched: already current, or listed but unresolvable now. */
  keep: string[];
  /** Shared targets only: destination exists and is not ours. */
  blocked: string[];
  removed: string[];
  /** Ledger slugs whose `SKILL.md` is on disk — asked by three rules below. */
  present: ReadonlySet<string>;
  /** This target holds another connection's installation, being replaced whole. */
  contextChanged: boolean;
}

export interface Catalogue {
  bySlug: SkillsBySlug;
  /** Listed but unresolvable — not the definite "not published". Decides deletion. */
  unresolved: Set<string>;
}

/**
 * A recorded `root` that does not match the current one describes a DIFFERENT
 * `~/.agents/skills` (cron, launchd and devcontainers resolve `HOME`
 * differently), so the ledger reads as empty and its directories are refused.
 */
export function ownedLedger(
  target: SyncTarget,
  state: SyncState,
  source: SkillSource,
  context: SyncContext,
): TargetState {
  const previous = state.targets[target];
  const root = targetRoot(target);
  return !previous || previous.root !== root ? emptyTargetState(source, root, context) : previous;
}

export async function diffTarget(
  target: SyncTarget,
  catalogue: Catalogue,
  state: SyncState,
  source: SkillSource,
  context: SyncContext,
): Promise<TargetPlan> {
  const ledger = ownedLedger(target, state, source, context);
  // A ledger from a build whose materializer differs is stale, but still owned.
  // An installation belonging to another connection is replaced whole, so its
  // preparation is all-or-nothing rather than graded per skill.
  const contextChanged =
    state.targets[target]?.root === targetRoot(target) && !sameContext(ledger.context, context);
  const stale = state.version !== STATE_VERSION || ledger.source !== source;
  const shared = target !== "claude-plugin";
  const present = new Set<string>();
  for (const slug of Object.keys(ledger.managed)) {
    if (await isMaterialized(target, slug)) present.add(slug);
  }
  const plan: TargetPlan = {
    target,
    ledger,
    write: [],
    keep: [],
    blocked: [],
    removed: [],
    present,
    contextChanged,
  };

  for (const [slug, skill] of catalogue.bySlug) {
    const managed = ledger.managed[slug];
    if (!managed) {
      // The shared roots hold the user's own skills, and the swap deletes what
      // it renames aside — so an unproven destination is left alone.
      if (shared && (await destinationExists(target, slug))) plan.blocked.push(slug);
      else plan.write.push(slug);
      continue;
    }
    // Not redundant with the integrity check: a hand-deleted skill keeps a
    // matching entry and would read as up to date forever.
    const current =
      !stale &&
      managed.integrity === skill.integrity &&
      managed.packageId === skill.packageId &&
      present.has(slug);
    (current ? plan.keep : plan.write).push(slug);
  }

  // Deletion is decided against the CATALOGUE, never against what resolved: a
  // 500 on `versions/latest` is not evidence that a skill is gone.
  for (const slug of Object.keys(ledger.managed).sort()) {
    if (catalogue.bySlug.has(slug)) continue;
    // The plugin is rebuilt by COPYING carried-over directories.
    const keepable = catalogue.unresolved.has(ledger.managed[slug]!.packageId) && present.has(slug);
    (keepable ? plan.keep : plan.removed).push(slug);
  }
  plan.write.sort();
  plan.keep.sort();
  return plan;
}

/**
 * `<skillDir>/SKILL.md`, NOT "the directory exists": a directory outlives its
 * `SKILL.md` and would still match the ledger while loading nowhere.
 */
async function isMaterialized(target: SyncTarget, slug: string): Promise<boolean> {
  try {
    return (await lstat(join(skillDir(target, slug), SKILL_ENTRY))).isFile();
  } catch {
    return false;
  }
}
