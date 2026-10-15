// SPDX-License-Identifier: Apache-2.0

/**
 * The grammar of a package manifest's `icon`, the same for every package type.
 *
 * AFPS reads `icon` as an archive path to a PNG or an absolute URI. Appstrate
 * writes two URI forms there: an image URL, and an Iconify icon id
 * (`<prefix>:<name>`, e.g. `logos:slack-icon`), whose prefix stands as the URI
 * scheme. The `lucide` prefix is singled out because an Appstrate surface draws
 * it from its own bundle rather than from the Iconify API — it is the set an
 * agent's icon is picked from.
 */

/** Iconify prefix of the Lucide set: `lucide:bot`. */
export const LUCIDE_ICON_PREFIX = "lucide:";

export type ManifestIcon =
  { kind: "lucide"; name: string } | { kind: "iconify"; id: string } | { kind: "url"; src: string };

/** An Iconify id: a lowercase prefix and name, kebab-case, joined by one colon. */
const ICONIFY_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*:[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Reads a manifest `icon`. `null` for anything a surface cannot draw: no value,
 * an archive path (the platform serves no package asset), or a bare name.
 */
export function parseManifestIcon(value: unknown): ManifestIcon | null {
  if (typeof value !== "string" || value === "") return null;
  if (/^https?:\/\//.test(value) || value.startsWith("data:image/")) {
    return { kind: "url", src: value };
  }
  if (!ICONIFY_ID.test(value)) return null;
  if (value.startsWith(LUCIDE_ICON_PREFIX)) {
    return { kind: "lucide", name: value.slice(LUCIDE_ICON_PREFIX.length) };
  }
  return { kind: "iconify", id: value };
}
