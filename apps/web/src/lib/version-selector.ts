// SPDX-License-Identifier: Apache-2.0

/**
 * The default version selector — the live editor working copy. Omitting a
 * version anywhere on the dashboard resolves the draft, preserving the
 * launch-badge / editor default (#770).
 */
export const VERSION_DRAFT = "draft";

/**
 * True when `version` pins a concrete published definition (a semver, dist-tag,
 * or `"published"`) rather than the draft. Drives whether a `?version=` query
 * param is sent and whether the cache key splits per version. Omitted or
 * `"draft"` → false (the draft verdict the badge has always shown).
 */
export function isVersioned(version: string | undefined): version is string {
  return !!version && version !== VERSION_DRAFT;
}
