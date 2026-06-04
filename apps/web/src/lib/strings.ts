// SPDX-License-Identifier: Apache-2.0

export { toSlug } from "@appstrate/core/naming";

/**
 * NFD-normalize, strip diacritics, and lowercase a string. Shared scaffold for
 * the slug- and credential-key derivatives below — each layer adds its own
 * character class and trim rules on top of this base.
 */
function normalizeBase(value: string): string {
  return value.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/** Like toSlug but keeps trailing hyphens — use during typing, finalize with toSlug on blur. */
export function toLiveSlug(value: string): string {
  return normalizeBase(value)
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+/, "");
}

/**
 * Canonicalize a credential schema key to the `^[a-z][a-z0-9_]*$` shape.
 *
 * Underscores are preserved (unlike {@link toSlug}) because the sidecar
 * substitution regex (`\w+`) does not match hyphens. Used by the agent
 * editor's credentials mode for the field-name input.
 *
 * Guarantees the output is either empty or matches `^[a-z][a-z0-9_]*$` — in
 * particular, strips any leading non-letter characters (digits, underscores)
 * so the pattern's `^[a-z]` anchor is never violated.
 */
export function toCredentialKey(value: string): string {
  return normalizeBase(value)
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^[^a-z]+/, "")
    .replace(/_+$/, "");
}

/** Like toCredentialKey but keeps trailing underscores — use during typing. */
export function toLiveCredentialKey(value: string): string {
  return normalizeBase(value)
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^[^a-z]+/, "");
}
