// SPDX-License-Identifier: Apache-2.0

/**
 * Ownership ledger for `appstrate skills sync`.
 *
 * Two jobs, and the second is the one that matters:
 *
 *  1. **Diff.** Each managed slug records the `integrity` of the artifact it
 *     was materialized from, so a re-run that resolves the same integrity
 *     skips the download entirely. That is what keeps the once-per-session
 *     background run cheap on the package routes (rate limited at 50/window).
 *  2. **Ownership.** `codex` and `claude-user` write into directories the user
 *     also fills by hand (`~/.agents/skills/`, `~/.claude/skills/`). The sync
 *     may only ever delete — or overwrite — a directory this file lists as
 *     ours for that target. Without the ledger, "remove skills that
 *     disappeared server-side" has no safe implementation: it would have to
 *     guess from the filesystem, and a wrong guess deletes hand-written work.
 *
 * The file lives OUTSIDE every target tree (`<dataDir>/skills-sync/state.json`)
 * because the Claude Code plugin directory's version is the hash of its
 * contents: a state blob inside it would change on every sync and make each
 * run look like a new plugin version.
 *
 * A file that does not validate degrades to "nothing is managed" and never
 * throws. The cost of that choice is bounded and known: the next sync
 * re-downloads everything and, in the shared roots, refuses the directories it
 * can no longer prove it wrote instead of deleting them.
 *
 * Validation is hand-written because the shape is three fields per entry —
 * far below what a schema library would earn back.
 */

import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { getDataDir } from "../config.ts";

/**
 * Ledger format AND materialization format, in one number.
 *
 * It covers both because a reader only ever asks one question of it: "would
 * this CLI produce the same bytes for the same artifact?" A ledger written by
 * a build whose `SKILL.md` normalizer, plugin manifest or README differ
 * answers no, and every entry it holds is stale — the integrity digests still
 * match the SERVER's artifacts, so nothing else in the diff would notice.
 *
 * BUMP THIS whenever PER-SKILL materialized output changes: the frontmatter
 * rewrite, the drop list, or the ledger's own shape. The plugin's fixed files
 * (`PLUGIN_MANIFEST`, `PLUGIN_README`) need no bump — `pluginTreeMatches`
 * compares them by content, so a change to either reaches an existing tree on
 * its own without re-downloading every artifact.
 *
 * A mismatch marks every entry stale; it does NOT discard ownership. Those are
 * different claims: "these bytes are out of date" and "these directories are
 * not mine". Conflating them would make an upgrade refuse to touch its own
 * output in `~/.agents/skills/`.
 */
export const STATE_VERSION = 1;

/** What the sync materialized for one slug, and from which artifact. */
export interface ManagedSkill {
  /** `@scope/name` of the Appstrate package this directory came from. */
  packageId: string;
  /** Resolved version label — semver for `published`, `"draft"` for `draft`. */
  version: string;
  /**
   * Change token for the materialized bytes. SRI digest for a published
   * version; for a draft, the files-index ETag folded with `lock_version`
   * (a draft has no immutable digest to quote).
   */
  integrity: string;
}

export interface TargetState {
  /** Which side of `--source` produced these entries. */
  source: "published" | "draft";
  /**
   * Absolute root these entries were written under.
   *
   * Recorded because `HOME` is not a constant: the same profile run from cron,
   * launchd, `sudo -E` or a devcontainer can resolve a different
   * `~/.agents/skills`. A ledger whose root does not match the current one
   * describes somebody else's directories, and acting on it would delete or
   * overwrite them. When it differs, the reader treats the target's ledger as
   * empty — so every directory it finds is unmanaged, i.e. refused rather
   * than clobbered.
   */
  root: string;
  /** Slug → provenance. Keys ARE the directory names this sync owns. */
  managed: Record<string, ManagedSkill>;
}

export interface SyncState {
  /** {@link STATE_VERSION} at the time of writing. */
  version: number;
  targets: Record<string, TargetState>;
}

export function getStatePath(): string {
  return join(getDataDir(), "skills-sync", "state.json");
}

function emptySyncState(): SyncState {
  return { version: STATE_VERSION, targets: {} };
}

export function emptyTargetState(source: TargetState["source"], root: string): TargetState {
  return { source, root, managed: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isManagedSkill(value: unknown): value is ManagedSkill {
  return (
    isRecord(value) &&
    isNonEmptyString(value.packageId) &&
    isNonEmptyString(value.version) &&
    isNonEmptyString(value.integrity)
  );
}

function isTargetState(value: unknown): value is TargetState {
  if (!isRecord(value)) return false;
  if (value.source !== "published" && value.source !== "draft") return false;
  if (!isNonEmptyString(value.root)) return false;
  if (!isRecord(value.managed)) return false;
  return Object.values(value.managed).every(isManagedSkill);
}

/**
 * Total validation of a parsed `state.json`. Total rather than partial on
 * purpose: a file that is half-valid describes ownership we cannot trust, and
 * "own nothing" is the only safe reading of a shape we do not recognize.
 */
function isSyncState(value: unknown): value is SyncState {
  if (!isRecord(value)) return false;
  if (typeof value.version !== "number") return false;
  if (!isRecord(value.targets)) return false;
  return Object.values(value.targets).every(isTargetState);
}

/**
 * Read the ledger. `corrupt` is true when a file existed but did not validate
 * — the caller warns on stderr; a missing file is the ordinary first-run case
 * and is not corruption.
 */
export async function readSyncState(): Promise<{ state: SyncState; corrupt: boolean }> {
  let raw: string;
  try {
    raw = await readFile(getStatePath(), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { state: emptySyncState(), corrupt: false };
    }
    // Unreadable for any other reason (permissions, a directory in its place)
    // is the same verdict as unparseable: we cannot prove ownership, so we
    // claim none.
    return { state: emptySyncState(), corrupt: true };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: emptySyncState(), corrupt: true };
  }
  if (!isSyncState(parsed)) return { state: emptySyncState(), corrupt: true };
  return { state: parsed, corrupt: false };
}

/**
 * Overwrite the ledger atomically.
 *
 * `write-file-atomic` (O_EXCL tmp with a crypto-random suffix, fsync, rename,
 * fsync of the parent) is what `lib/keyring.ts` and `lib/install/upgrade.ts`
 * already use — a sync interrupted mid-write must not leave a file that
 * validates as "we own nothing" while the directories are still on disk.
 *
 * Keys are emitted sorted so a state file diffs cleanly between runs.
 */
export async function writeSyncState(state: SyncState): Promise<void> {
  await mkdir(join(getDataDir(), "skills-sync"), { recursive: true, mode: 0o700 });
  await writeFileAtomic(getStatePath(), `${JSON.stringify(sortState(state), null, 2)}\n`, {
    mode: 0o600,
  });
}

function sortState(state: SyncState): SyncState {
  const targets: Record<string, TargetState> = {};
  for (const target of Object.keys(state.targets).sort()) {
    const entry = state.targets[target]!;
    const managed: Record<string, ManagedSkill> = {};
    for (const slug of Object.keys(entry.managed).sort()) {
      managed[slug] = entry.managed[slug]!;
    }
    targets[target] = { source: entry.source, root: entry.root, managed };
  }
  return { version: state.version, targets };
}
