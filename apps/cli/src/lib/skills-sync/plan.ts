// SPDX-License-Identifier: Apache-2.0

/**
 * Server half of `appstrate skills sync`: what to sync, at which version, and
 * under which directory name.
 *
 * The shape of the work is fixed by what the platform already exposes — there
 * is no bulk endpoint, so it is one list call plus one small resolution call
 * per skill, and artifact downloads only for what actually changed:
 *
 *   GET /api/packages/skills                                   → the catalogue
 *   GET /api/packages/skills/@s/n/versions/latest              → version + SRI
 *   GET /api/packages/@s/n/<version>/download                  → the artifact
 *
 * `--source draft` swaps the last two for the draft detail route and the file
 * explorer, which is the only way to read an unpublished skill's supporting
 * files.
 *
 * Concurrency is capped at 8: the package route family is rate limited at 50
 * requests per window, and a large org would otherwise spend its budget on the
 * resolution pass alone and fail the downloads.
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
import { emptyTargetState, STATE_VERSION, type SyncState, type TargetState } from "./state.ts";
import { destinationExists, skillDir, targetRoot, type SyncTarget } from "./targets.ts";

/** Ceiling on in-flight package-route requests. See the module docstring. */
export const MAX_CONCURRENCY = 8;

export type SkillSource = "published" | "draft";

class SkillSyncError extends Error {
  constructor(
    public readonly code: "integrity_mismatch" | "malformed_response",
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "SkillSyncError";
  }
}

/** The subset of the skills list DTO this sync reads. */
interface SkillListRow {
  id: string;
  source?: string;
}

/** One entry of the file-explorer index (`buildFileIndex`). */
export interface FileIndexEntry {
  path?: unknown;
  /** Full text of a small text file, already carried by the index. */
  inline?: unknown;
}

/** One skill pinned to a concrete artifact, before slug assignment. */
export interface ResolvedSkill {
  /** `@scope/name`. */
  packageId: string;
  /** Version label — semver for `published`, the literal `draft` otherwise. */
  version: string;
  /** Change token: SRI for a published artifact, ETag + lock for a draft. */
  integrity: string;
  /** Frontmatter `name` of the skill's `SKILL.md`, empty when it has none. */
  frontmatterName: string;
  /** AFPS manifest `description`, empty when the manifest has none. */
  manifestDescription: string;
  /**
   * Draft only: the file index whose ETag produced `integrity`, kept so the
   * download does not re-request it.
   */
  draftIndex?: FileIndexEntry[];
}

/** A resolved skill with the directory name it will be written under. */
export interface PlannedSkill extends ResolvedSkill {
  slug: string;
  /** Set when a collision forced the `<scope>-<name>` fallback (D4). */
  renamedFrom?: string;
}

/**
 * Skills installed in the pinned space, sorted by package id.
 *
 * System packages are dropped: they are the platform's, not the org's, and a
 * user syncing "my organization's skills" did not ask for them. There are none
 * today — the filter is what keeps that true if that changes.
 *
 * Sorting here is what makes every downstream decision stable, collision
 * resolution above all: which of two skills keeps the short slug must not
 * depend on the order the server happened to return them in.
 */
export async function listSyncableSkills(profileName: string): Promise<string[]> {
  const rows = await apiList<SkillListRow>(profileName, "/api/packages/skills");
  return rows
    .filter((row) => row.source !== "system" && typeof row.id === "string" && row.id.length > 0)
    .map((row) => row.id)
    .sort();
}

/**
 * Pin one skill to the artifact the sync will materialize.
 *
 * Returns `null` for a skill with no published version — a legitimate state
 * for a package being drafted, and a note on stderr rather than a failure.
 */
export async function resolveSkill(
  profileName: string,
  packageId: string,
  source: SkillSource,
): Promise<ResolvedSkill | null> {
  return source === "published"
    ? resolvePublished(profileName, packageId)
    : resolveDraft(profileName, packageId);
}

async function resolvePublished(
  profileName: string,
  packageId: string,
): Promise<ResolvedSkill | null> {
  interface VersionDetail {
    version?: unknown;
    integrity?: unknown;
    content?: unknown;
    manifest?: unknown;
  }
  let detail: VersionDetail;
  try {
    detail = await apiFetch<VersionDetail>(
      profileName,
      `/api/packages/skills/${encodePackageIdPath(packageId)}/versions/latest`,
    );
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
  if (typeof detail.version !== "string" || typeof detail.integrity !== "string") {
    throw new SkillSyncError(
      "malformed_response",
      `Version detail for ${packageId} is missing version or integrity`,
      "The instance is running an incompatible API version.",
    );
  }
  return {
    packageId,
    version: detail.version,
    integrity: detail.integrity,
    frontmatterName: frontmatterNameOf(detail.content),
    manifestDescription: manifestDescriptionOf(detail.manifest),
  };
}

async function resolveDraft(profileName: string, packageId: string): Promise<ResolvedSkill | null> {
  interface DraftDetail {
    content?: unknown;
    manifest?: unknown;
    lock_version?: unknown;
  }
  let detail: DraftDetail;
  try {
    detail = await apiFetch<DraftDetail>(
      profileName,
      `/api/packages/skills/${encodePackageIdPath(packageId)}`,
    );
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
  // A draft has no immutable digest, so the change token is built from the two
  // values that DO move with its content: the file-explorer index ETag (which
  // the server derives from the artifact snapshot) and `lock_version` (which
  // the optimistic-concurrency layer bumps on every write).
  const res = await apiFetchRaw(
    profileName,
    `/api/packages/${encodePackageIdPath(packageId)}/files`,
  );
  if (!res.ok) {
    throw new SkillSyncError(
      "malformed_response",
      `Draft file index for ${packageId} failed: HTTP ${res.status} ${res.statusText}`,
      "Re-run without `--source draft`, or check that the skill still exists.",
    );
  }
  const etag = res.headers.get("etag") ?? "";
  const lock = typeof detail.lock_version === "number" ? String(detail.lock_version) : "0";
  const index = (await res.json()) as { entries?: FileIndexEntry[] };
  return {
    packageId,
    version: "draft",
    integrity: `draft:${lock}:${etag}`,
    frontmatterName: frontmatterNameOf(detail.content),
    manifestDescription: manifestDescriptionOf(detail.manifest),
    // Carried rather than re-requested: the index answered here IS the index
    // the download needs, and the ETag that makes it the change token is only
    // meaningful for the body it came with. Two calls would also be two
    // different snapshots on a draft edited between them.
    draftIndex: index.entries ?? [],
  };
}

/**
 * Assign each resolved skill its Agent Skills directory name.
 *
 * Input order decides collisions: the first claimant of a slug keeps it, and
 * every later one falls back to `<scope>-<name>` (D4). Callers pass a list
 * sorted by package id, so the assignment is a pure function of the org's
 * contents and never of request timing.
 */
export function assignSlugs(
  resolved: ResolvedSkill[],
  reserved: ReadonlySet<string> = new Set(),
): PlannedSkill[] {
  // `reserved` holds the slugs of packages that ARE in the catalogue but whose
  // resolution failed this run. Their directories stay on disk, so their names
  // are still taken — without this, a transient 500 on one skill would hand
  // its `/appstrate:<slug>` command to a different skill.
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
 * Download and verify one skill's files.
 *
 * The published path verifies the downloaded bytes against the server-issued
 * `X-Integrity` before anything is unpacked — the same discipline
 * `commands/run/bundle-fetch.ts` applies to agent bundles, and the reason a
 * mismatch is fatal for that skill instead of a warning.
 */
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
  );
  if (!res.ok) {
    throw new SkillSyncError(
      "malformed_response",
      `Download of ${skill.packageId}@${skill.version} failed: HTTP ${res.status} ${res.statusText}`,
    );
  }
  // Prefer the header over the value carried in the plan: it is what THIS
  // response claims about THESE bytes. Falling back to the resolved integrity
  // keeps the check meaningful on an instance that omits the header rather
  // than silently skipping verification.
  const advertised = res.headers.get("x-integrity") ?? skill.integrity;
  const bytes = new Uint8Array(await res.arrayBuffer());
  const verdict = verifyArtifactIntegrity(bytes, advertised);
  if (!verdict.valid) {
    throw new SkillSyncError(
      "integrity_mismatch",
      `Integrity mismatch for ${skill.packageId}@${skill.version}: expected ${advertised}, downloaded ${verdict.computed}`,
      "Retry the sync. If it persists, the instance or a proxy is corrupting artifacts.",
    );
  }
  // `unzipArtifact`, not `parsePackageZip`: the sync needs the ENTRIES, and
  // `parsePackageZip` additionally re-validates the embedded manifest with the
  // author-input policy (`retiredRuntimeTools: "reject"`). Applying that to a
  // published, integrity-verified artifact the platform already accepted would
  // make an old skill unsyncable over a manifest key it cannot rewrite. The
  // decompression bounds that actually protect us are kept explicitly — the
  // same 50 MB ceiling `parsePackageZip` applies, not `unzipArtifact`'s looser
  // 200 MB default — and `stripWrapperPrefix` preserves the single-wrapper-
  // folder handling `parsePackageZip` provided.
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
  // Resolution already read this index — its ETag is half the change token —
  // so re-requesting it would be a second rate-limited call describing a
  // snapshot that may already have moved.
  const entries =
    skill.draftIndex ??
    (await apiFetch<{ entries?: FileIndexEntry[] }>(profileName, `/api/packages/${encoded}/files`))
      .entries ??
    [];

  const wanted = entries
    .filter(
      (entry): entry is FileIndexEntry & { path: string } =>
        typeof entry.path === "string" && entry.path.length > 0 && !DROPPED_ENTRIES.has(entry.path),
    )
    .sort((a, b) => a.path.localeCompare(b.path));

  const files: Record<string, Uint8Array> = {};
  const encoder = new TextEncoder();
  // The index already carries the full text of every small text file it could
  // fit in its budget — and a skill is mostly small text files. Re-requesting
  // those would double the request count for nothing.
  const remaining = wanted.filter((entry) => {
    if (typeof entry.inline !== "string") return true;
    files[entry.path] = encoder.encode(entry.inline);
    return false;
  });

  const fetched = await mapWithConcurrency(remaining, MAX_CONCURRENCY, async (entry) => {
    const res = await apiFetchRaw(
      profileName,
      `/api/packages/${encoded}/files/content?path=${encodeURIComponent(entry.path)}`,
    );
    if (!res.ok) {
      throw new SkillSyncError(
        "malformed_response",
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

function manifestDescriptionOf(manifest: unknown): string {
  if (!manifest || typeof manifest !== "object") return "";
  const description = (manifest as Record<string, unknown>).description;
  return typeof description === "string" ? description : "";
}

// ---------------------------------------------------------------------------
// Diff — what each target must do about the resolved catalogue
// ---------------------------------------------------------------------------

export /** Slug assignment is global, so every plan indexes into the same map. */
type SkillsBySlug = ReadonlyMap<string, PlannedSkill>;

/**
 * What one target's diff decided, in four buckets of slugs.
 *
 * `write` and `keep` are the whole of it: a slug either needs fresh bytes or
 * it does not. The report tells "new" from "refreshed" by asking `ledger`,
 * which is where that distinction already lives.
 */
export interface TargetPlan {
  target: SyncTarget;
  /** The ledger this run may act on — resolved once, read everywhere. */
  ledger: TargetState;
  /** Needs fresh bytes: new, changed, or missing on disk. */
  write: string[];
  /**
   * Carried over untouched with its existing ledger entry — either already
   * current, or still listed by the server but unresolvable this run (a 500,
   * a 429). Identical treatment, so identical bucket.
   */
  keep: string[];
  /** Shared targets only: destination exists and is not ours. */
  blocked: string[];
  /** Managed slugs whose package left the catalogue. */
  removed: string[];
  /**
   * Ledger slugs whose `SKILL.md` is on disk. Computed once here — the
   * staleness check, the retention rule and the failed-download carry-over all
   * ask this same question about this same set.
   */
  present: ReadonlySet<string>;
}

/** What one resolution pass learned about the space's catalogue. */
export interface Catalogue {
  bySlug: SkillsBySlug;
  /**
   * Ids the server LISTED but whose version could not be resolved. Distinct
   * from "not published": that is a definite answer, this is no answer at all,
   * and the difference decides whether a directory is deleted or kept.
   */
  unresolved: Set<string>;
}

/**
 * The ledger this run may act on for `target`.
 *
 * A recorded `root` that does not match the current one means the entries
 * describe a DIFFERENT `~/.agents/skills` — the same profile under cron,
 * launchd, `sudo -E` or a devcontainer resolves `HOME` differently. Those are
 * somebody else's directories, so the ledger reads as empty: every existing
 * directory becomes unmanaged, i.e. refused rather than clobbered.
 */
export function ownedLedger(
  target: SyncTarget,
  state: SyncState,
  source: SkillSource,
): TargetState {
  const previous = state.targets[target];
  const root = targetRoot(target);
  return !previous || previous.root !== root ? emptyTargetState(source, root) : previous;
}

export async function diffTarget(
  target: SyncTarget,
  catalogue: Catalogue,
  state: SyncState,
  source: SkillSource,
): Promise<TargetPlan> {
  const ledger = ownedLedger(target, state, source);
  // A ledger written by a build whose materializer differs describes bytes
  // this CLI would not produce, even though the server-side integrity still
  // matches. Everything is stale — but ownership is untouched, so the shared
  // roots refresh their own directories instead of refusing them.
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
  };

  for (const [slug, skill] of catalogue.bySlug) {
    const managed = ledger.managed[slug];
    if (!managed) {
      // `~/.agents/skills/` and `~/.claude/skills/` also hold the user's own
      // skills. A destination we cannot prove we created is left completely
      // alone: the atomic swap renames the existing directory aside and
      // deletes it, so writing here would be silent data loss.
      if (shared && (await destinationExists(target, slug))) plan.blocked.push(slug);
      else plan.write.push(slug);
      continue;
    }
    // The on-disk check is not redundant with the integrity check: a user who
    // deleted a synced skill by hand has a ledger entry that still matches,
    // and without it the sync would report the skill up to date forever.
    const current =
      !stale &&
      managed.integrity === skill.integrity &&
      managed.packageId === skill.packageId &&
      present.has(slug);
    (current ? plan.keep : plan.write).push(slug);
  }

  // Deletion is decided against the CATALOGUE, never against what resolved.
  // A 500 or a 429 on `versions/latest` is not evidence that a skill is gone,
  // and treating it as such deleted the directory from every target — leaving
  // `--print-path` to hand Claude Code a correct-looking, empty plugin.
  for (const slug of Object.keys(ledger.managed).sort()) {
    if (catalogue.bySlug.has(slug)) continue;
    // Keeping is only meaningful while there is something to keep: the plugin
    // is rebuilt by COPYING carried-over directories, so an entry whose
    // directory is gone would fail the rebuild.
    const keepable = catalogue.unresolved.has(ledger.managed[slug]!.packageId) && present.has(slug);
    (keepable ? plan.keep : plan.removed).push(slug);
  }
  plan.write.sort();
  plan.keep.sort();
  return plan;
}

/**
 * Whether a materialized skill is actually present for `slug`.
 *
 * The test is `<skillDir>/SKILL.md`, NOT "the directory exists". A directory
 * outlives its `SKILL.md`: delete just that file and what is left — a
 * `references/` folder — is still a directory, still matches the ledger's
 * integrity, and is a skill neither Claude Code nor Codex will load.
 */
async function isMaterialized(target: SyncTarget, slug: string): Promise<boolean> {
  try {
    return (await lstat(join(skillDir(target, slug), SKILL_ENTRY))).isFile();
  } catch {
    return false;
  }
}
