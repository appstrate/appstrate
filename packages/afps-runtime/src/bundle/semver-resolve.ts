// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Generic 3-step semver resolution: exact match → dist-tag → semver range.
 *
 * Pure string-level helper. Callers are responsible for hydrating any
 * associated metadata (id, integrity, …) from the returned version
 * string, and for applying yank policy by pre-filtering the
 * `rangeVersions` and `distTags` inputs accordingly.
 *
 * Mirror of `resolveVersionString` in `@appstrate/core/semver`. This
 * package intentionally avoids an `@appstrate/core` runtime dependency
 * (it's published standalone), so the two implementations are kept in
 * sync deliberately. Update both when the algorithm changes.
 *
 * Returns the matched version string (e.g. `"1.2.3"`) or `null`.
 */

import semver from "semver";

export function resolveVersionString(
  query: string,
  exactVersions: readonly string[],
  rangeVersions: readonly string[],
  distTags: Readonly<Record<string, string>>,
): string | null {
  // 1. Exact match (caller decides whether yanked are included).
  if (semver.valid(query)) {
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
  if (semver.validRange(query)) {
    const candidates = rangeVersions.filter((v) => semver.valid(v) !== null);
    return semver.maxSatisfying([...candidates], query);
  }

  return null;
}
