// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

import semver from "semver";

// The canonical 3-step resolver lives in the shared zero-dependency package
// so the platform and the standalone `afps` CLI share one implementation.
// Imported (used internally by resolveVersionFromCatalog) and re-exported to
// preserve the `@appstrate/core/semver:resolveVersionString` public surface.
import { resolveVersionString } from "@appstrate/afps-shared/semver-resolve";
export { resolveVersionString };

/**
 * Strip a single leading `v`/`V` from a version tag. GitHub release tags are
 * `vX.Y.Z`; internal/wire versions are `X.Y.Z`. Only the prefix is touched —
 * prerelease and build metadata are left intact, so use this when the value is
 * going back into a tag-shaped URL (`download/v<tag>/…`), NOT for comparison.
 */
export function stripVersionPrefix(tag: string): string {
  return tag.replace(/^[vV]/, "");
}

/**
 * Normalize a version tag for COMPARISON: trim, strip a single leading `v`/`V`,
 * and drop build metadata (`+…`, which SemVer 2.0 §10 says MUST be ignored when
 * determining precedence). Two tags that differ only by a `v` prefix or build
 * metadata normalize to the same string, so cross-component equality checks stay
 * consistent — e.g. a version marker written by one component compares equal to
 * a pin passed to another. Use this (not {@link stripVersionPrefix}) whenever the
 * result feeds an equality/ordering check.
 */
export function normalizeVersion(tag: string): string {
  return stripVersionPrefix(tag.trim()).split("+", 1)[0]!;
}

/** Check whether `v` is a valid semver version string. */
export function isValidVersion(v: string): boolean {
  return semver.valid(v) !== null;
}

/** Check whether `v` is a valid semver range string. */
export function isValidRange(v: string): boolean {
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

export type VersionBump = "major" | "minor" | "patch";

/** Auto-bump a release segment of `currentVersion`. Returns null if invalid semver. */
export function bumpVersion(currentVersion: string, release: VersionBump): string | null {
  return semver.inc(currentVersion, release);
}

/** Auto-bump the patch segment of `currentVersion`. Returns null if invalid semver. */
export function bumpPatch(currentVersion: string): string | null {
  return bumpVersion(currentVersion, "patch");
}

/**
 * What publishing a draft would cut, given the draft manifest's version and the
 * latest published one (`GET …/versions/info`). One decision for every
 * publishing surface — the dashboard's dialog and the CLI — because the server
 * cuts whatever it is handed and enforces forward-only on its own:
 *
 * - `bump` — the draft still carries the published version: the next version is
 *   `latest` bumped by `bump`, sent as the override.
 * - `direct` — the draft is ahead of `latest`, or nothing is published: the
 *   draft's own version is cut, no override.
 * - `blocked` — the draft is BEHIND `latest`; forward-only would refuse it.
 * - `none` — the draft carries no valid version to reason about.
 *
 * `target` is the version the publish would create; `override` is the body's
 * `version`, set only when it differs from what the draft already says.
 */
export type PublishVersionPlan =
  | { kind: "bump"; target: string; override: string }
  | { kind: "direct"; target: string; override: undefined }
  | { kind: "blocked"; target: undefined; override: undefined }
  | { kind: "none"; target: undefined; override: undefined };

export function planPublishVersion(
  draftVersion: string | null | undefined,
  latestPublished: string | null | undefined,
  bump: VersionBump,
): PublishVersionPlan {
  if (!draftVersion || !isValidVersion(draftVersion)) {
    return { kind: "none", target: undefined, override: undefined };
  }
  if (!latestPublished || semver.gt(draftVersion, latestPublished)) {
    return { kind: "direct", target: draftVersion, override: undefined };
  }
  if (semver.eq(draftVersion, latestPublished)) {
    const next = bumpVersion(latestPublished, bump);
    if (next) return { kind: "bump", target: next, override: next };
  }
  return { kind: "blocked", target: undefined, override: undefined };
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
