// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

import semver from "semver";

/** Check whether `v` is a valid semver version string. */
export function isValidVersion(v: string): boolean {
  return semver.valid(v) !== null;
}

/** Check whether `v` is a valid semver range string. */
function isValidRange(v: string): boolean {
  return semver.validRange(v) !== null;
}

/** Comparator for sorting versions in descending order (highest first). */
export function compareVersionsDesc(a: string, b: string): number {
  return semver.rcompare(a, b);
}

/** Find the highest version in `versions` that satisfies `range`, or `null` if none match. */
export function matchVersion(versions: string[], range: string): string | null {
  return semver.maxSatisfying(versions, range);
}

/** Auto-bump the patch segment of `currentVersion`. Returns null if invalid semver. */
export function bumpPatch(currentVersion: string): string | null {
  return semver.inc(currentVersion, "patch");
}

/** A dist-tag entry mapping a tag name to a version ID. */
export interface DistTagEntry {
  /** Tag name (e.g. "latest", "beta"). */
  tag: string;
  /** ID of the version this tag points to. */
  versionId: number;
}

/** A version entry in a package catalog with yank status. */
export interface CatalogVersion {
  /** Unique version identifier. */
  id: number;
  /** Semver version string. */
  version: string;
  /** Whether this version has been yanked from distribution. */
  yanked: boolean;
}

/**
 * Resolve a version query against a catalog of versions and dist-tags.
 * 3-step resolution: exact match → dist-tag → semver range.
 *
 * - Exact match includes yanked versions (like npm/crates.io: exact pins always resolve).
 * - Dist-tag lookup excludes yanked versions.
 * - Semver range excludes yanked versions.
 *
 * Returns the version id, or null if no match.
 */
export function resolveVersionFromCatalog(
  query: string,
  versions: CatalogVersion[],
  distTags: DistTagEntry[],
): number | null {
  // 1. Exact match — includes yanked
  if (isValidVersion(query)) {
    const exact = versions.find((v) => v.version === query);
    if (exact) return exact.id;
    return null;
  }

  // 2. Dist-tag — excludes yanked
  const tagEntry = distTags.find((t) => t.tag === query);
  if (tagEntry) {
    const tagged = versions.find((v) => v.id === tagEntry.versionId && !v.yanked);
    if (tagged) return tagged.id;
  }

  // 3. Semver range — excludes yanked
  if (isValidRange(query)) {
    const nonYanked = versions.filter((v) => !v.yanked);
    const versionStrings = nonYanked.map((v) => v.version).filter(isValidVersion);
    const best = matchVersion(versionStrings, query);
    if (!best) return null;
    const match = nonYanked.find((v) => v.version === best);
    return match?.id ?? null;
  }

  return null;
}
