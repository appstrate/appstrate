// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * SSRF protection — re-exported from the shared zero-dependency
 * `@appstrate/afps-shared` package. The `@appstrate/core/ssrf` public
 * surface is preserved verbatim (`isBlockedHost`, `isBlockedUrl`).
 *
 * The implementation lives in `@appstrate/afps-shared/ssrf` so the shared
 * outbound-HTTP engine in `@appstrate/afps-runtime` (which ships with the
 * standalone `afps` CLI and must NOT take a runtime dependency on
 * `@appstrate/core`) can reach the exact same blocklist used by the
 * platform credential proxy and the sidecar.
 *
 * See `@appstrate/afps-shared/ssrf` for the full contract.
 */

export { isBlockedHost, isBlockedUrl } from "@appstrate/afps-shared/ssrf";
