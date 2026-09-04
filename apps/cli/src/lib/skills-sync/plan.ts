// SPDX-License-Identifier: Apache-2.0

/**
 * Server half of `appstrate skills sync`. No bulk endpoint exists, so it is one
 * list call, one resolution call per skill, and downloads only for what
 * changed; concurrency is capped because the package routes are rate limited.
 */

import { apiFetch, apiFetchRaw, apiList, ApiError } from "../api.ts";
import { encodePackageIdPath, parseScopedName } from "@appstrate/core/naming";
import { verifyArtifactIntegrity } from "@appstrate/core/integrity";
import {
  PACKAGE_ZIP_MAX_DECOMPRESSED_BYTES,
  stripWrapperPrefix,
  unzipArtifact,
} from "@appstrate/core/zip";
import { extractSkillMeta } from "@appstrate/core/validation";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { mapWithConcurrency } from "@appstrate/core/map-with-concurrency";
import { collisionSlug, DROPPED_ENTRIES, SKILL_ENTRY, skillSlug } from "./materialize.ts";
import {
  emptyTargetState,
  ledgerKey,
  STATE_VERSION,
  type SyncState,
  type TargetState,
} from "./state.ts";
import {
  destinationExists,
  skillDir,
  targetRoot,
  type Layout,
  type SyncTarget,
} from "./targets.ts";

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

interface SkillListRow {
  id: string;
  source?: string;
}

export interface FileIndexEntry {
  path?: unknown;
  /** Full text of a small text file, already carried by the index. */
  inline?: unknown;
}

export interface ResolvedSkill {
  packageId: string;
  /**
   * The space the package was listed from. The package routes only answer for
   * a package installed in the space of the request, so every later call about
   * this skill carries this id — not the profile's pinned one.
   */
  spaceId: string;
  version: string;
  /** SRI for a published artifact, ETag + `lock_version` for a draft. */
  integrity: string;
  /** Frontmatter `name` of the skill's `SKILL.md`, empty when it has none. */
  frontmatterName: string;
  /** Draft only: the index whose ETag produced `integrity`, kept to avoid a refetch. */
  draftIndex?: FileIndexEntry[];
}

export interface PlannedSkill extends ResolvedSkill {
  slug: string;
  /** Set when a collision forced the `<scope>-<name>` fallback (D4). */
  renamedFrom?: string;
}

export interface ListedSkill {
  packageId: string;
  spaceId: string;
}

/** The request header that scopes the package routes to one space. */
export function spaceHeaders(spaceId: string): Record<string, string> {
  return { "X-Space-Id": spaceId };
}

/**
 * The union of the given spaces' skills, sorted by package id, which is what
 * makes collision resolution reproducible rather than server-order dependent.
 * A package installed in several spaces is listed once, from the first space
 * that carries it (input order). System packages are the platform's.
 */
export async function listSyncableSkills(
  profileName: string,
  spaceIds: string[],
): Promise<ListedSkill[]> {
  const seen = new Map<string, ListedSkill>();
  for (const spaceId of spaceIds) {
    const rows = await apiList<SkillListRow>(profileName, "/api/packages/skills", {
      headers: spaceHeaders(spaceId),
    });
    for (const row of rows) {
      if (row.source === "system" || typeof row.id !== "string" || row.id.length === 0) continue;
      if (!seen.has(row.id)) seen.set(row.id, { packageId: row.id, spaceId });
    }
  }
  return [...seen.values()].sort((a, b) => a.packageId.localeCompare(b.packageId));
}

/** `null` means no published version — a note on stderr, not a failure. */
export async function resolveSkill(
  profileName: string,
  listed: ListedSkill,
  source: SkillSource,
): Promise<ResolvedSkill | null> {
  return source === "published"
    ? resolvePublished(profileName, listed)
    : resolveDraft(profileName, listed);
}

async function resolvePublished(
  profileName: string,
  { packageId, spaceId }: ListedSkill,
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
      { headers: spaceHeaders(spaceId) },
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
    spaceId,
    version: detail.version,
    integrity: detail.integrity,
    frontmatterName: frontmatterNameOf(detail.content),
  };
}

async function resolveDraft(
  profileName: string,
  { packageId, spaceId }: ListedSkill,
): Promise<ResolvedSkill | null> {
  interface DraftDetail {
    content?: unknown;
    lock_version?: unknown;
  }
  let detail: DraftDetail;
  try {
    detail = await apiFetch<DraftDetail>(
      profileName,
      `/api/packages/skills/${encodePackageIdPath(packageId)}`,
      { headers: spaceHeaders(spaceId) },
    );
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
  // A draft has no immutable digest: the change token is the index ETag and
  // `lock_version`, the two values that DO move with its content.
  const res = await apiFetchRaw(
    profileName,
    `/api/packages/${encodePackageIdPath(packageId)}/files`,
    { headers: spaceHeaders(spaceId) },
  );
  if (!res.ok) {
    throw new SkillSyncError(
      `Draft file index for ${packageId} failed: HTTP ${res.status} ${res.statusText}`,
      "Re-run without `--source draft`, or check that the skill still exists.",
    );
  }
  const etag = res.headers.get("etag") ?? "";
  const lock = typeof detail.lock_version === "number" ? String(detail.lock_version) : "0";
  const index = (await res.json()) as { entries?: FileIndexEntry[] };
  return {
    packageId,
    spaceId,
    version: "draft",
    integrity: `draft:${lock}:${etag}`,
    frontmatterName: frontmatterNameOf(detail.content),
    // This IS the index the download needs, and its ETag is only meaningful
    // for the body it came with.
    draftIndex: index.entries ?? [],
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

/** The published path checks `X-Integrity` before anything is unpacked. */
export async function fetchSkillFiles(
  profileName: string,
  skill: ResolvedSkill,
  source: SkillSource,
): Promise<Record<string, Uint8Array>> {
  return source === "published"
    ? fetchPublishedFiles(profileName, skill)
    : fetchDraftFiles(profileName, skill);
}

async function fetchPublishedFiles(
  profileName: string,
  skill: ResolvedSkill,
): Promise<Record<string, Uint8Array>> {
  const res = await apiFetchRaw(
    profileName,
    `/api/packages/${encodePackageIdPath(skill.packageId)}/${encodeURIComponent(skill.version)}/download`,
    { headers: spaceHeaders(skill.spaceId) },
  );
  if (!res.ok) {
    throw new SkillSyncError(
      `Download of ${skill.packageId}@${skill.version} failed: HTTP ${res.status} ${res.statusText}`,
    );
  }
  // The header is what THIS response claims about THESE bytes; the fallback
  // keeps the check meaningful on an instance that omits it.
  const advertised = res.headers.get("x-integrity") ?? skill.integrity;
  const bytes = new Uint8Array(await res.arrayBuffer());
  const verdict = verifyArtifactIntegrity(bytes, advertised);
  if (!verdict.valid) {
    throw new SkillSyncError(
      `Integrity mismatch for ${skill.packageId}@${skill.version}: expected ${advertised}, downloaded ${verdict.computed}`,
      "Retry the sync. If it persists, the instance or a proxy is corrupting artifacts.",
    );
  }
  // `unzipArtifact`, not `parsePackageZip`: the latter re-validates the
  // manifest with the author-input policy, which would make an old published
  // artifact unsyncable. Its bounds and wrapper handling are kept explicitly.
  return stripWrapperPrefix(
    unzipArtifact(bytes, { maxDecompressedBytes: PACKAGE_ZIP_MAX_DECOMPRESSED_BYTES }),
  );
}

async function fetchDraftFiles(
  profileName: string,
  skill: ResolvedSkill,
): Promise<Record<string, Uint8Array>> {
  const packageId = skill.packageId;
  const encoded = encodePackageIdPath(packageId);
  // Resolution already read this index; a second call would describe a
  // snapshot that may have moved.
  const entries =
    skill.draftIndex ??
    (
      await apiFetch<{ entries?: FileIndexEntry[] }>(
        profileName,
        `/api/packages/${encoded}/files`,
        { headers: spaceHeaders(skill.spaceId) },
      )
    ).entries ??
    [];

  const wanted = entries
    .filter(
      (entry): entry is FileIndexEntry & { path: string } =>
        typeof entry.path === "string" && entry.path.length > 0 && !DROPPED_ENTRIES.has(entry.path),
    )
    .sort((a, b) => a.path.localeCompare(b.path));

  const files: Record<string, Uint8Array> = {};
  const encoder = new TextEncoder();
  // The index already carries the text of every small file.
  const remaining = wanted.filter((entry) => {
    if (typeof entry.inline !== "string") return true;
    files[entry.path] = encoder.encode(entry.inline);
    return false;
  });

  const fetched = await mapWithConcurrency(remaining, MAX_CONCURRENCY, async (entry) => {
    const res = await apiFetchRaw(
      profileName,
      `/api/packages/${encoded}/files/content?path=${encodeURIComponent(entry.path)}`,
      { headers: spaceHeaders(skill.spaceId) },
    );
    if (!res.ok) {
      throw new SkillSyncError(
        `Draft file "${entry.path}" of ${packageId} failed: HTTP ${res.status} ${res.statusText}`,
      );
    }
    return new Uint8Array(await res.arrayBuffer());
  });
  remaining.forEach((entry, i) => {
    files[entry.path] = fetched[i]!;
  });
  return files;
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
  scope: SyncScope,
): TargetState {
  const previous = state.targets[ledgerKey(scope.profileName, target)];
  const root = targetRoot(target, scope.layout);
  return !previous || previous.root !== root ? emptyTargetState(source, root) : previous;
}

/** Which profile is syncing, and where its plugin tree lives. */
export interface SyncScope {
  profileName: string;
  layout: Layout;
}

export async function diffTarget(
  target: SyncTarget,
  catalogue: Catalogue,
  state: SyncState,
  source: SkillSource,
  scope: SyncScope,
): Promise<TargetPlan> {
  const ledger = ownedLedger(target, state, source, scope);
  // A ledger from a build whose materializer differs is stale, but still owned.
  const stale = state.version !== STATE_VERSION || ledger.source !== source;
  const shared = target !== "claude-plugin";
  const present = new Set<string>();
  for (const slug of Object.keys(ledger.managed)) {
    if (await isMaterialized(target, slug, scope.layout)) present.add(slug);
  }
  const plan: TargetPlan = {
    target,
    ledger,
    write: [],
    keep: [],
    blocked: [],
    removed: [],
    present,
  };

  for (const [slug, skill] of catalogue.bySlug) {
    const managed = ledger.managed[slug];
    if (!managed) {
      // The shared roots hold the user's own skills, and the swap deletes what
      // it renames aside — so an unproven destination is left alone.
      if (shared && (await destinationExists(target, slug, scope.layout))) plan.blocked.push(slug);
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
async function isMaterialized(target: SyncTarget, slug: string, layout: Layout): Promise<boolean> {
  try {
    return (await lstat(join(skillDir(target, slug, layout), SKILL_ENTRY))).isFile();
  } catch {
    return false;
  }
}
