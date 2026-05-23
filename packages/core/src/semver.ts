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

/** Check whether `version` satisfies the semver `range`. */
export function satisfiesRange(version: string, range: string): boolean {
  return semver.satisfies(version, range);
}

/** Auto-bump the patch segment of `currentVersion`. Returns null if invalid semver. */
export function bumpPatch(currentVersion: string): string | null {
  return semver.inc(currentVersion, "patch");
}

/**
 * Wrap a version in npm's default caret range form (`^X.Y.Z`).
 * Used wherever the platform needs to write a dependency entry whose
 * version was previously left as the `"*"` wildcard — same recommendation
 * `npm install foo` writes (auto-receive non-breaking fixes within the
 * current major, opt-in major bumps).
 */
export function caretRange(version: string): string {
  return `^${version}`;
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
 * Generic 3-step semver resolution: exact match → dist-tag → semver range.
 *
 * Pure string-level helper. Callers are responsible for hydrating any
 * associated metadata (id, integrity, …) from the returned version
 * string, and for applying yank policy by pre-filtering the
 * `rangeVersions` and `distTags` inputs accordingly.
 *
 * Conventional yank policy (matches npm/crates.io and the canonical
 * {@link resolveVersionFromCatalog} below):
 * - `exactVersions`: include yanked (exact pins always resolve).
 * - `distTags`: exclude tags pointing at yanked versions.
 * - `rangeVersions`: exclude yanked.
 *
 * Returns the matched version string (e.g. `"1.2.3"`) or `null`.
 */
export function resolveVersionString(
  query: string,
  exactVersions: readonly string[],
  rangeVersions: readonly string[],
  distTags: Readonly<Record<string, string>>,
): string | null {
  // 1. Exact match (caller decides whether yanked are included).
  if (isValidVersion(query)) {
    return exactVersions.includes(query) ? query : null;
  }

  // 2. Dist-tag (caller pre-filters out tags pointing at yanked).
  const tagged = distTags[query];
  if (tagged !== undefined) {
    if (rangeVersions.includes(tagged) || exactVersions.includes(tagged)) {
      return tagged;
    }
    // Tag found but the target was filtered out (e.g. yanked) — do
    // not fall through to range resolution; tags are not ranges.
    return null;
  }

  // 3. Semver range.
  if (isValidRange(query)) {
    const candidates = rangeVersions.filter(isValidVersion);
    return matchVersion([...candidates], query);
  }

  return null;
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
 *
 * Internally delegates to {@link resolveVersionString} so the
 * algorithm stays consistent across all platform call sites.
 */
export function resolveVersionFromCatalog(
  query: string,
  versions: CatalogVersion[],
  distTags: DistTagEntry[],
): number | null {
  if (versions.length === 0) return null;

  const byVersion = new Map<string, CatalogVersion>();
  for (const v of versions) byVersion.set(v.version, v);

  const exactVersionStrings = versions.map((v) => v.version);
  const rangeVersionStrings = versions.filter((v) => !v.yanked).map((v) => v.version);

  const distTagMap: Record<string, string> = {};
  for (const t of distTags) {
    const target = versions.find((v) => v.id === t.versionId && !v.yanked);
    if (target) distTagMap[t.tag] = target.version;
  }

  const matched = resolveVersionString(query, exactVersionStrings, rangeVersionStrings, distTagMap);
  if (matched === null) return null;
  return byVersion.get(matched)?.id ?? null;
}
