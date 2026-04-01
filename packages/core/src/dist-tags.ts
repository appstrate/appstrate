// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/** Regex for valid dist-tag names: lowercase alphanumeric, dots, hyphens, underscores. */
export const DIST_TAG_REGEX = /^[a-z][a-z0-9._-]*$/;

/** Check whether `tag` is a valid dist-tag name. */
export function isValidDistTag(tag: string): boolean {
  return DIST_TAG_REGEX.test(tag);
}

/** Check whether `tag` is a protected tag that cannot be manually set or removed. */
export function isProtectedTag(tag: string): boolean {
  return tag === "latest";
}
