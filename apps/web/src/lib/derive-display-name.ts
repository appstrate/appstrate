// SPDX-License-Identifier: Apache-2.0

/**
 * Derive a sensible default display name from an email address. Used by
 * RegisterPage to pre-fill the display-name field from the locked
 * bootstrap email (issue #228), so the operator only has to type a
 * password instead of three fields.
 *
 * Splits the local part on common separators (`.`, `_`, `-`), drops
 * plus-addressing, capitalizes each segment, and joins with spaces.
 * Returns "" for malformed or meaningless input so the field stays
 * empty and the user fills it in manually instead of getting noise.
 *
 * Examples:
 *   admin@acme.com         → "Admin"
 *   john.doe@acme.com      → "John Doe"
 *   jane_smith@acme.com    → "Jane Smith"
 *   admin+ops@acme.com     → "Admin"
 *   42@acme.com            → ""  (numeric-only — meaningless as a name)
 */
export function deriveDisplayNameFromEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "";
  const localPart = email.slice(0, at).split("+")[0] ?? "";
  if (!/[a-zA-Z]/.test(localPart)) return "";
  return localPart
    .split(/[._-]+/)
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase())
    .join(" ");
}
