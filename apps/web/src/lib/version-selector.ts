// SPDX-License-Identifier: Apache-2.0

/**
 * The editor working copy. Reserved to callers who can WRITE the package in
 * its home space — the server answers `403 draft_not_writable` to anyone
 * else — so a launch surface sends it only when `home_writable` says so.
 */
export const VERSION_DRAFT = "draft";

/**
 * The version carrying the `latest` dist-tag. Identical in effect to sending
 * no selector at all (#636); spelled out where a control needs a value to
 * hold — a `<Select>` cannot hold absence — and never as a rewrite of an
 * omitted selector on a surface that has no such control.
 */
export const VERSION_PUBLISHED = "published";

/**
 * The selector a launch surface sends when the user picked none.
 *
 * `undefined` is the meaningful answer and must reach the query param as an
 * ABSENT `?version=`: an omitted selector is what resolves the latest
 * published version (#636). The draft is offered only to a caller who can
 * WRITE the package in its home space — the server refuses everyone else with
 * `403 draft_not_writable`, so proposing it elsewhere would be proposing a
 * button that cannot work.
 *
 * The two launch surfaces read this differently, on purpose, and both are
 * correct. The plain "Run" button sends this answer verbatim, absence
 * included: nobody picked anything. The "Run with options" modal shows a
 * `<Select>`, which needs a value to hold, so a caller who cannot write the
 * package starts on {@link VERSION_PUBLISHED} and the modal sends that word
 * — an option the user saw and left alone IS a pick. The two resolve to the
 * same definition; they differ in what they claim about the caller, and
 * `runs.version_ref` records the same thing either way.
 */
export function defaultRunVersion(homeWritable: boolean | undefined): string | undefined {
  return homeWritable ? VERSION_DRAFT : undefined;
}

/**
 * The selector that replays the definition a past run executed.
 *
 * `runs.version_ref` is unambiguous (#636): a concrete semver, or `"draft"`
 * when the run executed a working copy. A semver replays for anyone who can
 * launch the agent at all. A draft does not — it is the author's working copy,
 * it has moved since, and the server refuses it to anyone who cannot write the
 * package (`403 draft_not_writable`). Rather than replay a run that cannot be
 * replayed, the button falls back to this caller's own default: the latest
 * published version. Same bytes for the author, a legible one for everyone
 * else, and never a refusal the reader can do nothing about.
 */
export function replayVersion(
  versionRef: string,
  homeWritable: boolean | undefined,
): string | undefined {
  return versionRef === VERSION_DRAFT ? defaultRunVersion(homeWritable) : versionRef;
}

/**
 * True when `version` pins a concrete published definition (a semver, dist-tag,
 * or `"published"`) rather than the draft. Drives whether a `?version=` query
 * param is sent and whether the cache key splits per version. Omitted or
 * `"draft"` → false (the draft verdict the badge has always shown).
 */
export function isVersioned(version: string | undefined): version is string {
  return !!version && version !== VERSION_DRAFT;
}
