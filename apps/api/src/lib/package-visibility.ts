// SPDX-License-Identifier: Apache-2.0

/**
 * Package visibility — the `unlisted` level carried by the AFPS §10.1 `_meta`
 * extension mechanism under the `dev.appstrate/visibility` vendor namespace:
 *
 * ```json
 * { "_meta": { "dev.appstrate/visibility": { "level": "unlisted" } } }
 * ```
 *
 * Semantics follow NuGet unlisted / Chrome Web Store unlisted — DISCOVERABILITY,
 * not access control. An unlisted package is excluded from every listing surface
 * (package list routes, the library catalogue, the chat/get_me "attach to agent"
 * hints) but stays fully resolvable by exact id: the detail GET, explicit
 * `dependencies.skills` references, and version resolution are unchanged. Any
 * caller authorized on the detail route may load it — do NOT lean on this flag
 * for security.
 *
 * `_meta` is validated and preserved verbatim by `@appstrate/core` manifest
 * schemas (values are open records), so no spec or core change is required.
 */

import { asRecord } from "@appstrate/core/safe-json";

/** AFPS §10.1 vendor namespace carrying the visibility extension. */
export const VISIBILITY_META_NAMESPACE = "dev.appstrate/visibility";

/**
 * Whether a manifest opts out of listing surfaces. Reads
 * `_meta["dev.appstrate/visibility"].level === "unlisted"` with safe narrowing —
 * any malformed or absent shape means listed (the default).
 */
export function isUnlisted(manifest: Record<string, unknown> | null | undefined): boolean {
  const visibility = asRecord(asRecord(manifest?._meta)[VISIBILITY_META_NAMESPACE]);
  return visibility.level === "unlisted";
}
