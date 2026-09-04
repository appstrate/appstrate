// SPDX-License-Identifier: Apache-2.0

/**
 * Ownership ledger: which directory each target owns, and from which artifact.
 * It lives outside every target tree because the plugin's version is the hash
 * of its contents. A file that does not validate claims nothing, never throws.
 */

import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { getDataDir } from "../config.ts";

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

export interface TargetState {
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
  /**
   * Keyed by {@link ledgerKey}: one ledger per (profile, target). Two profiles
   * pointing at different organizations share `~/.agents/skills`, and a ledger
   * that ignored the profile would let one profile's sync delete the other's
   * skills — they are absent from ITS catalogue.
   */
  targets: Record<string, TargetState>;
}

export function getStatePath(): string {
  return join(getDataDir(), "skills-sync", "state.json");
}

/** `<profile>:<target>`; the profile name cannot contain `:` (validated at login). */
export function ledgerKey(profileName: string, target: string): string {
  return `${profileName}:${target}`;
}

/**
 * Ledgers written before profiles were part of the key are bare target names.
 * They are adopted by the first profile to run after the upgrade — in
 * practice the only one that ever synced — and rewritten under its key.
 */
export function adoptLegacyLedgers(state: SyncState, profileName: string): SyncState {
  const targets: Record<string, TargetState> = {};
  for (const [key, entry] of Object.entries(state.targets)) {
    const adopted = key.includes(":") ? key : ledgerKey(profileName, key);
    if (!targets[adopted]) targets[adopted] = entry;
  }
  return { version: state.version, targets };
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
    targets[target] = { source: entry.source, root: entry.root, managed };
  }
  return { version: state.version, targets };
}
