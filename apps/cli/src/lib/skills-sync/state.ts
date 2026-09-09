// SPDX-License-Identifier: Apache-2.0

/**
 * Ownership ledger: which directory each target owns, and from which artifact.
 * It lives outside every target tree because the plugin's version is the hash
 * of its contents. A file that does not validate claims nothing, never throws.
 */

import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { normalizeInstance } from "../instance-url.ts";
import { getDataDir, type Profile } from "../config.ts";

/**
 * BUMP whenever PER-SKILL materialized output changes: the server-side digests
 * cannot answer "would this CLI produce the same bytes?". A mismatch marks
 * every entry stale; it does NOT discard ownership.
 */
export const STATE_VERSION = 1;

export interface ManagedSkill {
  packageId: string;
  /** Resolved version label — semver for `published`, `"draft"` for `draft`. */
  version: string;
  /** SRI digest, or for a draft the files-index ETag folded with `lock_version`. */
  integrity: string;
}

/**
 * Which connection an installation belongs to. One per destination: profiles do
 * not accumulate installations, so every managed directory under a target was
 * written by this context.
 *
 * The pinned space is NOT part of it: it selects no skill (D14), it only fills
 * the `X-Space-Id` header of the generated `.mcp.json` — content
 * `pluginTreeMatches` already compares and rewrites. Switching space installs
 * the same skills, so it is a property of the plugin, not a different owner.
 */
export interface SyncContext {
  profileName: string;
  instance: string;
  userId: string;
  orgId: string;
}

/**
 * `satisfies` makes this exhaustive in both directions, so a field added to
 * `SyncContext` cannot slip past validation or comparison by being forgotten here.
 */
const CONTEXT_KEYS = Object.keys({
  profileName: 0,
  instance: 0,
  userId: 0,
  orgId: 0,
} satisfies Record<keyof SyncContext, 0>) as (keyof SyncContext)[];

export function syncContext(profileName: string, profile: Profile): SyncContext {
  return {
    profileName,
    instance: normalizeInstance(profile.instance),
    userId: profile.userId,
    orgId: profile.orgId!,
  };
}

export function sameContext(a: SyncContext, b: SyncContext): boolean {
  return CONTEXT_KEYS.every((key) => a[key] === b[key]);
}

export interface TargetState {
  /**
   * Required: a ledger that does not name its context is not this format, and
   * `isTargetState` refuses it rather than guessing whose directories these are.
   */
  context: SyncContext;
  source: "published" | "draft";
  /**
   * Recorded because `HOME` is not a constant — cron, launchd and devcontainers
   * resolve a different `~/.agents/skills`, and that ledger claims nothing here.
   */
  root: string;
  managed: Record<string, ManagedSkill>;
}

export interface SyncState {
  version: number;
  targets: Record<string, TargetState>;
}

export function getStatePath(): string {
  return join(getDataDir(), "skills-sync", "state.json");
}

function emptySyncState(): SyncState {
  return { version: STATE_VERSION, targets: {} };
}

export function emptyTargetState(
  source: TargetState["source"],
  root: string,
  context: SyncContext,
): TargetState {
  return { context, source, root, managed: {} };
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
  if (!isContext(value.context)) return false;
  if (!isRecord(value.managed)) return false;
  return Object.values(value.managed).every(isManagedSkill);
}

function isSyncState(value: unknown): value is SyncState {
  if (!isRecord(value)) return false;
  if (typeof value.version !== "number") return false;
  if (!isRecord(value.targets)) return false;
  return Object.values(value.targets).every(isTargetState);
}

/** `corrupt` means a file existed but did not validate; a missing one does not. */
export async function readSyncState(): Promise<{ state: SyncState; corrupt: boolean }> {
  let raw: string;
  try {
    raw = await readFile(getStatePath(), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { state: emptySyncState(), corrupt: false };
    }
    // Unreadable for any other reason is the same verdict as unparseable.
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

/** Atomic: a half-written ledger would validate as "we own nothing". */
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
    targets[target] = { ...entry, managed };
  }
  return { version: state.version, targets };
}

/**
 * The key set is EXACT. A context carrying anything else — a `spaceId`, say —
 * was written in a shape this CLI no longer produces, and reading it through a
 * narrower comparison would be a second, untested code path for a format
 * nothing writes. It is refused whole, exactly like a context-less ledger: the
 * run reports the state as unusable and re-materializes everything.
 */
function isContext(value: unknown): value is SyncContext {
  return (
    isRecord(value) &&
    Object.keys(value).length === CONTEXT_KEYS.length &&
    CONTEXT_KEYS.every((key) => isNonEmptyString(value[key]))
  );
}
