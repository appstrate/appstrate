// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

import semver from "semver";
import { isValidVersion, compareVersionsDesc } from "./semver.ts";

type ForwardVersionError = "VERSION_EXISTS" | "VERSION_NOT_HIGHER" | "VERSION_INVALID";

interface ForwardVersionResult {
  ok: boolean;
  error?: ForwardVersionError;
  highest?: string;
}

/**
 * Validate that `newVersion` is strictly higher than all existing versions.
 * Callers must pass ALL versions (including yanked) to prevent re-publishing.
 * Rejects duplicates and versions not higher than the current maximum.
 */
function validateForwardVersion(
  newVersion: string,
  existingVersions: string[],
): ForwardVersionResult {
  if (!isValidVersion(newVersion)) {
    return { ok: false, error: "VERSION_INVALID" };
  }

  if (existingVersions.includes(newVersion)) {
    return { ok: false, error: "VERSION_EXISTS" };
  }

  const validVersions = existingVersions.filter(isValidVersion);
  if (validVersions.length === 0) {
    return { ok: true };
  }

  const highest = validVersions.sort(compareVersionsDesc)[0]!;
  if (!semver.gt(newVersion, highest)) {
    return { ok: false, error: "VERSION_NOT_HIGHER", highest };
  }

  return { ok: true };
}

/**
 * Find the best candidate for dist-tag reassignment after a yank:
 * highest non-yanked, non-prerelease version.
 */
function findBestStableVersion(
  candidates: Array<{ id: number; version: string }>,
): { id: number; version: string } | null {
  const stable = candidates.filter((v) => semver.prerelease(v.version) === null);
  if (stable.length === 0) return null;

  const sorted = stable.sort((a, b) => compareVersionsDesc(a.version, b.version));
  return sorted[0]!;
}

/**
 * Determine whether a newly published version should replace the "latest" dist-tag.
 * Prereleases never update "latest". A stable version updates "latest" only if
 * there is no current latest or the new version is >= the current one.
 */
export function shouldUpdateLatestTag(
  newVersion: string,
  currentLatestVersion: string | null,
): boolean {
  if (semver.prerelease(newVersion) !== null) return false;
  if (!currentLatestVersion) return true;
  return !semver.gt(currentLatestVersion, newVersion);
}

// ─────────────────────────────────────────────
// Planning functions (pure decision logic)
// ─────────────────────────────────────────────

/** Outcome of planning a new version creation: insert, already exists, or rejected. */
export type CreateVersionOutcome =
  | { action: "insert"; shouldUpdateLatest: boolean }
  | { action: "exists" }
  | { action: "rejected"; error: "VERSION_NOT_HIGHER"; highest: string }
  | { action: "rejected"; error: "VERSION_INVALID" };

/**
 * Plan the outcome of creating a new version: insert, exists, or rejected.
 * Pure function consolidating `validateForwardVersion` + `shouldUpdateLatestTag`.
 */
export function planCreateVersionOutcome(
  newVersion: string,
  existingVersions: string[],
  currentLatestVersion: string | null,
): CreateVersionOutcome {
  const check = validateForwardVersion(newVersion, existingVersions);
  if (!check.ok) {
    if (check.error === "VERSION_EXISTS") return { action: "exists" };
    if (check.error === "VERSION_INVALID") return { action: "rejected", error: "VERSION_INVALID" };
    return { action: "rejected", error: "VERSION_NOT_HIGHER", highest: check.highest! };
  }
  return {
    action: "insert",
    shouldUpdateLatest: shouldUpdateLatestTag(newVersion, currentLatestVersion),
  };
}

/** Instruction for reassigning or deleting a dist-tag after a version yank. */
export type TagReassignment =
  | { tag: string; action: "reassign"; newVersionId: number }
  | { tag: string; action: "delete" };

/**
 * Plan dist-tag reassignments after a yank.
 * Returns instructions for each affected tag: reassign to best stable, or delete.
 */
export function planTagReassignment(
  affectedTags: { tag: string }[],
  nonYankedCandidates: { id: number; version: string }[],
): TagReassignment[] {
  if (affectedTags.length === 0) return [];
  const best = findBestStableVersion(nonYankedCandidates);
  return affectedTags.map(({ tag }) =>
    best
      ? { tag, action: "reassign" as const, newVersionId: best.id }
      : { tag, action: "delete" as const },
  );
}
