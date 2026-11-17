// SPDX-License-Identifier: Apache-2.0

/** The editor working copy; the server answers `403 draft_not_writable` unless the caller can WRITE the package in its home space. */
export const VERSION_DRAFT = "draft";

/** The `latest` dist-tag; same effect as no selector, for controls that need a value (a `<Select>` cannot hold absence). */
export const VERSION_PUBLISHED = "published";

/**
 * The selector sent when the user picked none. `undefined` must reach the query as an
 * ABSENT `?version=` (resolves the latest published); the draft only when `homeWritable`.
 * The "Run with options" `<Select>` needs a value, so a non-writer starts on {@link VERSION_PUBLISHED}.
 */
export function defaultRunVersion(homeWritable: boolean | undefined): string | undefined {
  return homeWritable ? VERSION_DRAFT : undefined;
}

/**
 * The selector that replays the definition a past run executed (`runs.version_ref`:
 * a semver or `"draft"`). A draft has moved since and is refused to non-writers
 * (`403 draft_not_writable`), so it falls back to this caller's own default.
 */
export function replayVersion(
  versionRef: string,
  homeWritable: boolean | undefined,
): string | undefined {
  return versionRef === VERSION_DRAFT ? defaultRunVersion(homeWritable) : versionRef;
}

/** True when `version` pins a published definition (semver, dist-tag, `"published"`), not the draft. */
export function isVersioned(version: string | undefined): version is string {
  return !!version && version !== VERSION_DRAFT;
}
