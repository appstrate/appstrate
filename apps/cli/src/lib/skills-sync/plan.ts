// SPDX-License-Identifier: Apache-2.0

/**
 * Server half of `appstrate code sync`: a client of the MCP Skills extension
 * (SEP-2640) through its REST reflection (`GET /api/mcp/skills…`, documented in
 * the OpenAPI). One list call per space (its published skills, or its drafts),
 * and downloads only for what changed, each file checked against its served
 * digest; concurrency is capped because the routes are rate limited.
 */

import { createHash } from "node:crypto";
import { apiFetchRaw, apiList, problemFields, sessionRevokedError } from "../api.ts";
import { isReservedScope, parseScopedName } from "@appstrate/core/naming";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { collisionSlug, SKILL_ENTRY } from "./materialize.ts";
import {
  emptyTargetState,
  type ManagedSkill,
  STATE_VERSION,
  sameContext,
  type SyncContext,
  type SyncState,
  type TargetState,
} from "./state.ts";
import { destinationExists, skillDir, targetRoot, type SyncTarget } from "./targets.ts";

export const MAX_CONCURRENCY = 8;

export type SkillSource = TargetState["source"];

const SKILLS_PATH = "/api/mcp/skills";
const SKILL_URI_PREFIX = "skill://";
const DRAFT_MARKER = "@draft";
const DRAFT_VERSION = "draft";

class SkillSyncError extends Error {
  constructor(
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "SkillSyncError";
  }
}

/** A file of a SEP-2640 skill entry. */
interface SkillResource {
  uri: string;
  digest: string;
  size: number;
}

/** A SEP-2640 skill entry, as `skills/list` and `skills/get` serve it. */
export interface SkillEntry {
  uri: string;
  frontmatter: { name: string; [key: string]: unknown };
  resources: SkillResource[];
}

export interface ResolvedSkill {
  packageId: string;
  /** The space the skill is read from: the authority of its `skill://` URIs. */
  spaceId: string;
  /** The served `metadata.version` of a published skill, `"draft"` for a draft. */
  version: string;
  /** Digest of the served files: their paths and `sha256` digests. */
  integrity: string;
  /** The served frontmatter `name`, a valid Agent Skills name. */
  frontmatterName: string;
  entry: SkillEntry;
}

export interface PlannedSkill extends ResolvedSkill {
  slug: string;
  /** Set when a collision forced a fallback newly assigned this run (D4). */
  renamedFrom?: string;
}

/** The parts of a `skill://<spaceId>/<scope>/<package-name>[@draft]/<name>/SKILL.md` URI the sync reads. */
interface SkillUriParts {
  spaceId: string;
  packageId: string;
  packageSegment: string;
}

function skillUriParts(uri: string): SkillUriParts | null {
  if (!uri.startsWith(SKILL_URI_PREFIX)) return null;
  const [spaceId, scope, packageSegment] = uri.slice(SKILL_URI_PREFIX.length).split("/");
  if (!spaceId || !scope || !packageSegment) return null;
  const name = packageSegment.endsWith(DRAFT_MARKER)
    ? packageSegment.slice(0, -DRAFT_MARKER.length)
    : packageSegment;
  const packageId = `@${scope}/${name}`;
  return parseScopedName(packageId) ? { spaceId, packageId, packageSegment } : null;
}

function malformed(what: string): SkillSyncError {
  return new SkillSyncError(
    `Malformed skill entry: ${what}`,
    "The instance is running an incompatible API version.",
  );
}

/** The files of `entry` by path inside the skill directory, `SKILL.md` included. */
function resourcePaths(entry: SkillEntry): Map<string, SkillResource> {
  if (!entry.uri.endsWith(`/${SKILL_ENTRY}`))
    throw malformed(`${entry.uri} is not a ${SKILL_ENTRY}`);
  const dir = entry.uri.slice(0, -SKILL_ENTRY.length);
  const paths = new Map<string, SkillResource>();
  for (const resource of entry.resources) {
    if (!resource.uri.startsWith(dir)) throw malformed(`${resource.uri} is outside ${dir}`);
    const path = resource.uri.slice(dir.length).split("/").map(decodeURIComponent).join("/");
    paths.set(path, resource);
  }
  if (!paths.has(SKILL_ENTRY)) throw malformed(`${entry.uri} lists no ${SKILL_ENTRY}`);
  return paths;
}

/** The version label of an entry: its served `metadata.version`, `"draft"` for a draft. */
function versionLabel(entry: SkillEntry, parts: SkillUriParts): string {
  if (parts.packageSegment.endsWith(DRAFT_MARKER)) return DRAFT_VERSION;
  const metadata = entry.frontmatter.metadata;
  const version =
    typeof metadata === "object" && metadata !== null
      ? (metadata as Record<string, unknown>).version
      : undefined;
  if (typeof version !== "string" || version === "") {
    throw malformed(`${entry.uri} has no metadata.version`);
  }
  return version;
}

/** A listed entry, checked and pinned by the digests of its files. */
export function resolveSkill(entry: SkillEntry): ResolvedSkill {
  const parts = skillUriParts(entry.uri);
  if (!parts) throw malformed(`${entry.uri} is not a skill:// URI`);
  const lines = [...resourcePaths(entry)]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, resource]) => `${resource.digest} ${path}`);
  const integrity = `sha256:${createHash("sha256").update(lines.join("\n")).digest("hex")}`;
  return {
    packageId: parts.packageId,
    spaceId: parts.spaceId,
    version: versionLabel(entry, parts),
    integrity,
    frontmatterName: entry.frontmatter.name,
    entry,
  };
}

/** The package id a listed entry's URI names. */
export function skillPackageId(entry: SkillEntry): string {
  const parts = skillUriParts(entry.uri);
  if (!parts) throw malformed(`${entry.uri} is not a skill:// URI`);
  return parts.packageId;
}

/**
 * The skills of the space at `source` (its published skills, or the drafts the
 * caller may read), system skills (the platform's, not the organization's) left
 * out. The server lists the ACTIVE set: a skill switched off in a space is one
 * somebody decided the space would not use, and a skill switched back on
 * reappears on the next sync, because the sync reads this list every time.
 */
export async function listSyncableSkills(
  profileName: string,
  spaceId: string,
  source: SkillSource,
): Promise<SkillEntry[]> {
  const path = source === "draft" ? `${SKILLS_PATH}?definition=draft` : SKILLS_PATH;
  const entries = await apiList<SkillEntry>(profileName, path, { spaceId });
  return entries.filter((entry) => {
    const parts = skillUriParts(entry.uri);
    return parts !== null && !isReservedScope(parseScopedName(parts.packageId)!.scope);
  });
}

/**
 * Every file of the skill, each checked against the size and digest its entry
 * serves, by path inside the skill directory.
 */
export async function fetchSkillFiles(
  profileName: string,
  skill: ResolvedSkill,
): Promise<Record<string, Uint8Array>> {
  const files: Record<string, Uint8Array> = {};
  for (const [path, resource] of resourcePaths(skill.entry)) {
    const res = await apiFetchRaw(
      profileName,
      `${SKILLS_PATH}/content?uri=${encodeURIComponent(resource.uri)}`,
      { spaceId: skill.spaceId },
    );
    if (res.status === 401) throw await sessionRevokedError(profileName);
    if (!res.ok) {
      const problem = problemFields(await res.json().catch(() => undefined));
      throw new SkillSyncError(
        `Reading ${resource.uri} failed: ${problem.detail ?? `HTTP ${res.status} ${res.statusText}`}`,
      );
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (bytes.byteLength !== resource.size || digest !== resource.digest) {
      throw new SkillSyncError(
        `${resource.uri} does not match its served digest`,
        "Re-run the sync; the skill may have changed during it.",
      );
    }
    files[path] = bytes;
  }
  return files;
}

/**
 * Newcomers collide in input order (sorted by package id). `incumbents`
 * (slug → holder) are never handed to another package this run. A skill takes
 * its served name when free, else the one it holds, else `<scope>-<name>`.
 */
export function assignSlugs(
  skills: ResolvedSkill[],
  incumbents: ReadonlyMap<string, Pick<ManagedSkill, "packageId">> = new Map(),
): { planned: PlannedSkill[] } {
  const taken = new Set<string>();
  const planned = skills.map((skill): PlannedSkill => {
    const { packageId } = skill;
    const preferred = skill.frontmatterName;
    const blocked = new Set(taken);
    let own: string | undefined;
    for (const [slug, holder] of incumbents) {
      if (holder.packageId !== packageId) blocked.add(slug);
      else own ??= slug;
    }
    const slug = !blocked.has(preferred) ? preferred : (own ?? collisionSlug(packageId, blocked));
    taken.add(slug);
    // Keeping the fallback it already holds is not news: only a new name is reported.
    return slug === preferred || slug === own
      ? { ...skill, slug }
      : { ...skill, slug, renamedFrom: preferred };
  });
  return { planned };
}

/** Slug assignment is global, so every plan indexes into the same map. */
export type EntriesBySlug = ReadonlyMap<string, PlannedSkill>;

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
  bySlug: EntriesBySlug;
  /** Package ids listed but unresolvable, unlike "not published". Decides deletion. */
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
  const wanted = catalogue.bySlug;
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

  for (const [slug, entry] of wanted) {
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
      managed.integrity === entry.integrity &&
      managed.packageId === entry.packageId &&
      present.has(slug);
    (current ? plan.keep : plan.write).push(slug);
  }

  // Deletion is decided against the CATALOGUE, never against what resolved: a
  // 500 on `versions/latest` is not evidence that a skill is gone.
  for (const slug of Object.keys(ledger.managed).sort()) {
    if (wanted.has(slug)) continue;
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
