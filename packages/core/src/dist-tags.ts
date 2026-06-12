// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/** Regex for valid dist-tag names: lowercase alphanumeric, dots, hyphens, underscores. */
export const DIST_TAG_REGEX = /^[a-z][a-z0-9._-]*$/;

/** Check whether `tag` is a valid dist-tag name. */
export function isValidDistTag(tag: string): boolean {
  return DIST_TAG_REGEX.test(tag);
}

/**
 * Tags that cannot be manually set or removed:
 *   - `latest` — platform-managed, reassigned automatically on publish/delete.
 *   - `draft` / `published` — reserved `version_ref` selector keywords. The
 *     run-version resolver (`agent-version-resolver.ts` in apps/api) resolves
 *     these keywords BEFORE dist-tag lookup, so a dist-tag with either name
 *     would be permanently shadowed and unreachable.
 */
const PROTECTED_TAGS = new Set(["latest", "draft", "published"]);

/** Check whether `tag` is a protected tag that cannot be manually set or removed. */
export function isProtectedTag(tag: string): boolean {
  return PROTECTED_TAGS.has(tag);
}
