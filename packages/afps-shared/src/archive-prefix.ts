// Copyright 2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * Wrapper-folder stripping for AFPS archives — the ONE place that answers
 * "did whoever zipped this wrap everything in a top-level directory, and if so
 * what is it?".
 *
 * ZIPs created by macOS Finder or `zip -r folder/` wrap all entries under a
 * single top-level directory, so a lookup like `files["manifest.json"]` misses.
 * Only strip when EVERY entry shares one first-level prefix and none sits at
 * the root; anything else is ambiguous and the collection comes back untouched,
 * by identity.
 *
 * Lives in the zero-dependency shared package because two packages that cannot
 * import each other both have to strip the same prefix the same way:
 *
 *  - **Core** (`@appstrate/core/zip`) — the platform's package-ZIP parser, over
 *    fflate's `Record<string, Uint8Array>` shape, plus the sanitized `Map`
 *    shape the bundle path hands it.
 *  - **AFPS runtime** (`@appstrate/afps-runtime` → `bundle/archive-utils.ts`) —
 *    the `.afps` ingestion path, over the sanitized `Map` shape.
 *
 * The runtime used to keep a hand-copy of core's `Map` branch under a comment
 * asking a human to "keep the two algorithms in sync", with no parity test to
 * police it. That is exactly the arrangement `@appstrate/afps-shared/mime`
 * replaced for the media-type set — where the policing parity test existed and
 * the copies drifted three times anyway, once corrupting every OOXML download.
 * `@appstrate/afps-runtime` deliberately carries no runtime dependency on core
 * (it ships as a portable bundle runner and a standalone `afps` CLI), and
 * afps-shared is a dependency of both, so one definition reaches both without
 * either taking on the other.
 *
 * Change the rule HERE, not at a call site.
 */

/**
 * Detect and strip a single common wrapper folder from archive entries.
 *
 * Accepts either a `Record<string, Uint8Array>` (fflate's default ZIP shape) or
 * a `Map<string, Uint8Array>` (the sanitized bundle shape) and returns the same
 * type as the input — the ORIGINAL object, by identity, when there is nothing
 * to strip.
 */
export function stripWrapperPrefix(files: Record<string, Uint8Array>): Record<string, Uint8Array>;
export function stripWrapperPrefix(files: Map<string, Uint8Array>): Map<string, Uint8Array>;
export function stripWrapperPrefix(
  files: Record<string, Uint8Array> | Map<string, Uint8Array>,
): Record<string, Uint8Array> | Map<string, Uint8Array> {
  const keys = files instanceof Map ? [...files.keys()] : Object.keys(files);
  const prefix = commonWrapperPrefix(keys);
  if (prefix === null) return files;

  if (files instanceof Map) {
    const stripped = new Map<string, Uint8Array>();
    for (const [key, value] of files) stripped.set(key.slice(prefix.length), value);
    return stripped;
  }
  const stripped: Record<string, Uint8Array> = {};
  for (const [key, value] of Object.entries(files)) {
    stripped[key.slice(prefix.length)] = value;
  }
  return stripped;
}

/**
 * The single wrapper prefix (WITH its trailing slash) every key shares, or
 * `null` when there is none to strip — no entries at all, an entry at the root
 * level, or more than one top-level folder (ambiguous).
 */
function commonWrapperPrefix(keys: readonly string[]): string | null {
  if (keys.length === 0) return null;
  const prefixes = new Set<string>();
  for (const key of keys) {
    const slashIdx = key.indexOf("/");
    if (slashIdx === -1) return null; // root-level file → no stripping
    prefixes.add(key.slice(0, slashIdx));
  }
  if (prefixes.size !== 1) return null; // multiple top-level folders → ambiguous
  return `${[...prefixes][0]}/`;
}
