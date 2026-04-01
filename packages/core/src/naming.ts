// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/** Regex pattern string for a valid slug: lowercase alphanumeric with optional hyphens. */
export const SLUG_PATTERN = "[a-z0-9]([a-z0-9-]*[a-z0-9])?";
/** Compiled regex for validating a single slug string. */
export const SLUG_REGEX = new RegExp(`^${SLUG_PATTERN}$`);

/**
 * Ensure a scope string is prefixed with `@`.
 * @param scope - Scope string, with or without leading `@`
 * @returns The scope prefixed with `@`
 * @throws Error if scope is empty
 */
export function normalizeScope(scope: string): string {
  if (!scope) throw new Error("Scope cannot be empty");
  return scope.startsWith("@") ? scope : `@${scope}`;
}

/**
 * Remove the leading `@` from a scope string.
 * @param scope - Scope string, with or without leading `@`
 * @returns The scope without the `@` prefix
 */
export function stripScope(scope: string): string {
  return scope.startsWith("@") ? scope.slice(1) : scope;
}

/** Parse "@scope/name" into { scope, name } or null if invalid.
 *  Both scope and name must be valid slugs (lowercase alphanumeric + hyphens). */
const SCOPED_NAME_REGEX = new RegExp(`^@(${SLUG_PATTERN})\\/(${SLUG_PATTERN})$`);

export function parseScopedName(scopedName: string): { scope: string; name: string } | null {
  const match = scopedName.match(SCOPED_NAME_REGEX);
  if (!match) return null;
  return { scope: match[1]!, name: match[3]! };
}

/** Single source of truth for package ownership. */
export function isOwnedByOrg(packageId: string, orgSlug: string): boolean {
  if (!orgSlug) return false;
  const parsed = parseScopedName(packageId);
  if (!parsed) return false;
  return parsed.scope === orgSlug;
}

/** Build a packageId from separated scope + name. */
export function buildPackageId(scope: string, name: string): string {
  const s = stripScope(scope);
  return `@${s}/${name}`;
}
