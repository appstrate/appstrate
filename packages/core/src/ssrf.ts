// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * SSRF protection — re-exported from the shared zero-dependency
 * `@appstrate/afps-shared` package. The `@appstrate/core/ssrf` public
 * surface is preserved verbatim (`isBlockedHost`, `isBlockedUrl`,
 * `resolveAndCheckHost`).
 *
 * The implementations live in `@appstrate/afps-shared` so the shared
 * outbound-HTTP engine in `@appstrate/afps-runtime` (which ships with the
 * standalone `afps` CLI and must NOT take a runtime dependency on
 * `@appstrate/core`) reaches the exact same blocklist AND the same
 * DNS-rebind layer used by the platform credential proxy and the sidecar:
 *   - `@appstrate/afps-shared/ssrf` — literal blocklist (zero builtins)
 *   - `@appstrate/afps-shared/ssrf-dns` — `resolveAndCheckHost`, the
 *     DNS-resolving layer (node:dns/node:net, server-side only)
 *
 * See those modules for the full contracts, including the resolve-and-pin
 * vs fail-closed-defence-in-depth consumer distinction.
 */

export { isBlockedHost, isBlockedUrl } from "@appstrate/afps-shared/ssrf";
export { resolveAndCheckHost } from "@appstrate/afps-shared/ssrf-dns";
export type { HostResolver, ResolvedHostCheck } from "@appstrate/afps-shared/ssrf-dns";
// `DEFAULT_MAX_REDIRECTS` is re-exported because a core consumer that calls
// `guardedFetch` from here has no other way to name its redirect ceiling:
// `GuardedFetchOptions` declares `maxRedirects` optional and the default lives
// in the leaf. Its ABSENCE is what made this subpath's CHANGELOG entry
// undeliverable — the entry described a budget the reader could not reference.
export {
  guardedFetch,
  SsrfBlockedError,
  DEFAULT_MAX_REDIRECTS,
} from "@appstrate/afps-shared/guarded-fetch";
export type { GuardedFetchOptions } from "@appstrate/afps-shared/guarded-fetch";
