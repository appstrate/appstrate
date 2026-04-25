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

/**
 * Convert an arbitrary human string into a URL-safe slug.
 * Lower-cases, strips diacritics, collapses non-[a-z0-9] runs into `-`
 * and trims leading/trailing dashes. Optional `maxLen` caps the result
 * (caller-side truncation of names like org slugs).
 *
 * Not the same as `SLUG_REGEX` — this accepts any input and produces a
 * valid slug; `SLUG_REGEX` validates that an already-formed string is
 * one. Callers that need validation should compose: `toSlug(x)` then
 * `SLUG_REGEX.test(result)`.
 */
export function toSlug(value: string, maxLen?: number): string {
  const out = value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return maxLen && maxLen > 0 ? out.slice(0, maxLen) : out;
}

/**
 * MCP tool name validation (Phase 4 of #276, V3 + V13 in the migration plan).
 *
 * The format is `{namespace_snake}__{tool_snake}` \u2014 two snake_case
 * tokens joined by a double underscore. Hard length ceiling 56 chars
 * leaves headroom under the 64-char OpenAI/Anthropic limit for
 * downstream host re-prefixing (Claude Code adds its own
 * `mcp__plugin_<plugin>_<server>__<tool>` super-prefix).
 *
 * Bifurcated predicates per V13 (npm pattern):
 * - `isValidToolNameForNew`: strict \u2014 used at registry publish time.
 * - `isValidToolNameForExisting`: lenient \u2014 used at runtime install
 *   so previously-published tools keep loading even after rules tighten.
 *
 * The runtime predicate is currently identical to the strict one \u2014
 * no legacy tool surface predates this validation. Future tightenings
 * (e.g. forbidding new digit-prefixed names) go through `isValidToolNameForNew`
 * only.
 */
export const TOOL_NAME_MAX_LEN = 56;
const TOOL_NAME_PATTERN_NEW = /^[a-z][a-z0-9_]*__[a-z][a-z0-9_]*$/;

export function isValidToolNameForNew(name: string): boolean {
  if (typeof name !== "string") return false;
  if (name.length === 0 || name.length > TOOL_NAME_MAX_LEN) return false;
  return TOOL_NAME_PATTERN_NEW.test(name);
}

/**
 * Lenient runtime check (V13). Mirrors `isValidToolNameForNew` for now;
 * extend the alphabet here (not in the strict predicate) when adding
 * legacy-tolerance for tightened rules.
 */
export function isValidToolNameForExisting(name: string): boolean {
  return isValidToolNameForNew(name);
}

/**
 * Normalise a raw tool name into the canonical snake_case `__`-joined
 * form. Returns the input unchanged when it's already valid.
 *
 * Mapping rules:
 * - Hyphens \u2192 underscores.
 * - Single-underscore separator (legacy) \u2192 double-underscore boundary
 *   (only when no `__` is already present).
 * - Mixed-case \u2192 lower-case.
 */
export function normalizeToolName(raw: string): string {
  if (typeof raw !== "string" || raw.length === 0) return raw;
  let out = raw.toLowerCase();
  out = out.replace(/[-]+/g, "_");
  // If there's no `__` boundary yet, promote the first single underscore.
  if (!out.includes("__")) {
    out = out.replace(/_/, "__");
  }
  return out.slice(0, TOOL_NAME_MAX_LEN);
}
