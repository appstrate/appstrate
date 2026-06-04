// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Byte-level Subresource Integrity (SRI) primitives, re-exported from the
 * shared zero-dependency `@appstrate/afps-shared` package — the single source
 * of truth shared with `@appstrate/core/integrity`.
 *
 * Returns the canonical SRI form (`sha256-<base64>`), directly usable in
 * `X-Integrity` HTTP headers, HTML `integrity` attributes, and signed bundle
 * manifests. Comparison in {@link verifyIntegrity} is constant-time when the
 * lengths match.
 */

export {
  computeIntegrity,
  verifyIntegrity,
  type IntegrityCheckResult,
} from "@appstrate/afps-shared/integrity";
