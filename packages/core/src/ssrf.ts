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
