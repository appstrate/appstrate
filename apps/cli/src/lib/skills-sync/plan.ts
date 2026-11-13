// SPDX-License-Identifier: Apache-2.0

/**
 * Server half of `appstrate code sync`: reads the skills as the instance serves
 * them to MCP clients (the MCP Skills extension, SEP-2640) through the package
 * API (`GET /api/packages/skills/served…`, documented in the OpenAPI). One list call per space (its published skills, or its drafts),
 * and one archive download per changed skill, each file checked against its
 * served digest; concurrency is capped because the routes are rate limited.
 */

import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parseSkillFrontmatter } from "@appstrate/afps-shared/companion-files";
import { ApiError, apiFetchRaw, apiList, problemFields, sessionRevokedError } from "../api.ts";
import { isReservedScope, parseScopedName } from "@appstrate/core/naming";
import { canonicalPackagePath } from "@appstrate/core/package-file-operations";
import { unzipArtifact } from "@appstrate/core/zip";
import {
  parseSkillUri,
  parseSkillUriPackage,
  SKILL_MAX_FILES,
  SKILL_MAX_TOTAL_BYTES,
  skillFileDigest,
  type SkillAddress,
  type SkillEntry,
  type SkillResource,
} from "@appstrate/core/skill-uri";
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

const SKILLS_PATH = "/api/packages/skills/served";
const DRAFT_VERSION = "draft";
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

class SkillSyncError extends Error {
  constructor(
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "SkillSyncError";
  }
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

function malformed(what: string): SkillSyncError {
  return new SkillSyncError(
    `Malformed skill entry: ${what}`,
    "The instance is running an incompatible API version.",
  );
}

/**
 * The address of `entry` and its files by path inside the skill directory,
 * `SKILL.md` included. Every URI must parse (a canonical `skill://` URI whose
 * path stays inside the skill directory) and name the entry's skill, whose
 * name is its frontmatter `name`. Every file has a `sha256` digest and a byte
 * size, within the SEP-2640 limits in count and in total. Two paths that are
 * one file on a case- or normalization-insensitive disk are refused.
 */
function entryFiles(entry: SkillEntry): {
  address: SkillAddress;
  files: Map<string, SkillResource>;
} {
  const address = typeof entry.uri === "string" ? parseSkillUri(entry.uri) : null;
  if (!address) throw malformed(`${entry.uri} is not a skill:// URI`);
  if (address.path !== SKILL_ENTRY) throw malformed(`${entry.uri} is not a ${SKILL_ENTRY}`);
  if (entry.frontmatter?.name !== address.name) {
    throw malformed(`${entry.uri} does not end with its frontmatter name`);
  }
  if (!Array.isArray(entry.resources) || entry.resources.length > SKILL_MAX_FILES) {
    throw malformed(`${entry.uri} lists no files, or more than ${SKILL_MAX_FILES}`);
  }
  const files = new Map<string, SkillResource>();
  const canonical = new Set<string>();
  let total = 0;
  for (const resource of entry.resources) {
    const file = typeof resource?.uri === "string" ? parseSkillUri(resource.uri) : null;
    if (
      !file ||
      file.spaceId !== address.spaceId ||
      file.packageId !== address.packageId ||
      file.definition !== address.definition ||
      file.name !== address.name
    ) {
      throw malformed(`${resource.uri} is not a file of ${entry.uri}`);
    }
    if (!Number.isSafeInteger(resource.size) || resource.size < 0) {
      throw malformed(`${resource.uri} has no byte size`);
    }
    if (typeof resource.digest !== "string" || !DIGEST_PATTERN.test(resource.digest)) {
      throw malformed(`${resource.uri} has no sha256 digest`);
    }
    // A case- or normalization-insensitive disk (macOS, Windows) holds one of
    // two such paths, and the second write would silently replace the first.
    const key = canonicalPackagePath(file.path);
    if (canonical.has(key)) throw malformed(`${resource.uri} is listed twice`);
    canonical.add(key);
    total += resource.size;
    files.set(file.path, resource);
  }
  if (total > SKILL_MAX_TOTAL_BYTES) {
    throw malformed(`${entry.uri} holds more than ${SKILL_MAX_TOTAL_BYTES} bytes`);
  }
  if (!files.has(SKILL_ENTRY)) throw malformed(`${entry.uri} lists no ${SKILL_ENTRY}`);
  return { address, files };
}

/** The version label of an entry: its served `metadata.version`, `"draft"` for a draft. */
function versionLabel(entry: SkillEntry, address: SkillAddress): string {
  if (address.definition === "draft") return DRAFT_VERSION;
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
  const { address, files } = entryFiles(entry);
  const lines = [...files]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, resource]) => `${resource.digest} ${path}`);
  const integrity = `sha256:${createHash("sha256").update(lines.join("\n")).digest("hex")}`;
  return {
    packageId: address.packageId,
    spaceId: address.spaceId,
    version: versionLabel(entry, address),
    integrity,
    frontmatterName: address.name,
    entry,
  };
}

/**
 * The package id a listed entry's URI names, read from its package segments so
 * that an entry the sync refuses still names the skill it keeps on disk.
 */
export function skillPackageId(entry: SkillEntry): string {
  const pkg = typeof entry.uri === "string" ? parseSkillUriPackage(entry.uri) : null;
  if (!pkg) throw malformed(`${entry.uri} names no package`);
  return pkg.packageId;
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
  let entries: SkillEntry[];
  try {
    entries = await apiList<SkillEntry>(profileName, path, { spaceId });
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      throw new SkillSyncError(
        `Listing the skills of space ${spaceId} failed: ${SKILLS_PATH} answered 404 (${err.message})`,
        "The instance does not serve this route (its version is older than this CLI's: ask its administrator to upgrade it), or the space is not readable.",
      );
    }
    throw err;
  }
  // An entry naming no package is kept, so the sync fails on it rather than
  // deleting the skill it may name.
  return entries.filter((entry) => {
    const pkg = typeof entry.uri === "string" ? parseSkillUriPackage(entry.uri) : null;
    return pkg === null || !isReservedScope(parseScopedName(pkg.packageId)!.scope);
  });
}

/**
 * Every file of the skill, read in one archive request and each checked
 * against the size and digest its entry serves, by path inside the skill
 * directory. The archive holds exactly the entry's files, and the frontmatter
 * of the received `SKILL.md` equals the entry's, field by field (SEP-2640).
 */
export async function fetchSkillFiles(
  profileName: string,
  skill: ResolvedSkill,
): Promise<Record<string, Uint8Array>> {
  const expected = entryFiles(skill.entry).files;
  const res = await apiFetchRaw(
    profileName,
    `${SKILLS_PATH}/archive?uri=${encodeURIComponent(skill.entry.uri)}`,
    { spaceId: skill.spaceId },
  );
  if (res.status === 401) throw await sessionRevokedError(profileName);
  if (!res.ok) {
    const problem = problemFields(await res.json().catch(() => undefined));
    throw new SkillSyncError(
      `Reading ${skill.entry.uri} failed: ${problem.detail ?? `HTTP ${res.status} ${res.statusText}`}`,
    );
  }
  const changed = new SkillSyncError(
    `${skill.entry.uri} does not match its served digests`,
    "Re-run the sync; the skill may have changed during it.",
  );
  let files: Record<string, Uint8Array>;
  try {
    // The entry bounds the archive: no more files or bytes than it lists.
    files = unzipArtifact(new Uint8Array(await res.arrayBuffer()), {
      maxFiles: expected.size,
      maxDecompressedBytes: [...expected.values()].reduce((sum, file) => sum + file.size, 0),
    });
  } catch {
    throw changed;
  }
  if (Object.keys(files).length !== expected.size) throw changed;
  for (const [path, resource] of expected) {
    const bytes = files[path];
    if (!bytes || bytes.byteLength !== resource.size) throw changed;
    if (skillFileDigest(bytes) !== resource.digest) throw changed;
  }
  const { fields } = parseSkillFrontmatter(new TextDecoder().decode(files[SKILL_ENTRY]));
  // The entry reached the CLI through JSON: both sides compare after the same
  // JSON round trip, so YAML values JSON has no spelling for (`.inf`, `-0`) match.
  const asJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
  if (!isDeepStrictEqual(asJson(fields), asJson(skill.entry.frontmatter))) {
    throw new SkillSyncError(
      `${skill.entry.uri} does not match the frontmatter of its entry`,
      "Re-run the sync; the skill may have changed during it.",
    );
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
  /** Carried over untouched: already current, or listed with an entry the sync refuses. */
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
  /** Package ids listed with an entry the sync refuses, unlike unlisted ones. Decides deletion. */
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
  // A ledger of another state version or source is stale, but still owned.
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
  // refused entry is not evidence that a skill is gone.
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
