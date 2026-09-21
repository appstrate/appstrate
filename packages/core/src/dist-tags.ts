// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/** Regex for valid dist-tag names: lowercase alphanumeric, dots, hyphens, underscores. */
export const DIST_TAG_REGEX = /^[a-z][a-z0-9._-]*$/;

/** Check whether `tag` is a valid dist-tag name. */
export function isValidDistTag(tag: string): boolean {
  return DIST_TAG_REGEX.test(tag);
}

/**
 * Tag names a caller may not name as a version selector:
 *   - `latest` — platform-managed. It is the ONLY dist-tag the platform ever
 *     writes: publish points it at the new version, and deleting a version
 *     retargets or drops it. There is no route that creates a tag.
 *   - `draft` / `published` — reserved selector keywords. Every resolver
 *     (`agent-version-resolver.ts` in apps/api) answers these two BEFORE it
 *     looks a dist-tag up, so a tag so named could never be reached.
 *
 * The one consumer is dependency-override validation
 * (`services/input-parser.ts`): a caller may pin a dependency to a version
 * spec, and these three words are not specs a pin may carry.
 */
const PROTECTED_TAGS = new Set(["latest", "draft", "published"]);

/** Check whether `tag` is a protected name a version selector may not carry. */
export function isProtectedTag(tag: string): boolean {
  return PROTECTED_TAGS.has(tag);
}
