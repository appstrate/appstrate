// SPDX-License-Identifier: Apache-2.0

/**
 * SSRF protection — re-exported from `@appstrate/core/ssrf`.
 *
 * Single source of truth lives in `packages/core/src/ssrf.ts`. The
 * sidecar imports it via the same workspace channel it already uses
 * for `@appstrate/core/sidecar-types`, so `bun build --compile --minify`
 * tree-shakes the rest of core. Kept as a thin re-export module so
 * existing sidecar imports (`./ssrf.ts`) continue to resolve.
 */

export { isBlockedHost, isBlockedUrl } from "@appstrate/core/ssrf";
