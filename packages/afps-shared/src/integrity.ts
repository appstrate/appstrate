// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * Subresource Integrity (SRI) primitives — the SINGLE source of truth,
 * re-exported by `@appstrate/core/integrity` (as `computeIntegrity` +
 * `verifyArtifactIntegrity`) and `@appstrate/afps-runtime/bundle/hash`
 * (as `computeIntegrity` + `verifyIntegrity`).
 *
 * Runtime-neutral: uses `node:crypto` (supported under both Node and Bun)
 * so the standalone `afps` CLI and the platform share one implementation.
 */

import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Compute a Subresource Integrity (SRI) hash for binary data.
 *
 * Returns a string in the canonical SRI form (`sha256-<base64>`), directly
 * usable in `X-Integrity` HTTP headers, HTML `integrity` attributes, and
 * signed bundle manifests.
 *
 * @param data - Binary content to hash.
 * @returns SRI string in the format `"sha256-{base64}"`.
 */
export function computeIntegrity(data: Uint8Array | Buffer): string {
  const hash = createHash("sha256");
  hash.update(data);
  return `sha256-${hash.digest("base64")}`;
}

/** Result of an integrity verification check. */
export interface IntegrityCheckResult {
  /** Whether the computed hash matches the expected value. */
  valid: boolean;
  /** The computed SRI hash string. Useful for error reporting. */
  computed: string;
}

/**
 * Verify binary data against an expected SRI hash.
 *
 * Comparison is constant-time when the lengths match — a short-circuit on
 * mismatched lengths is safe because SRI strings of a given algorithm have a
 * fixed length, and the length itself is not a secret.
 *
 * @param data - Binary content to hash.
 * @param expected - Expected SRI string (e.g. `"sha256-…"`).
 */
export function verifyIntegrity(data: Uint8Array, expected: string): IntegrityCheckResult {
  const computed = computeIntegrity(data);
  if (computed.length !== expected.length) {
    return { valid: false, computed };
  }
  const a = Buffer.from(computed, "utf8");
  const b = Buffer.from(expected, "utf8");
  return { valid: timingSafeEqual(a, b), computed };
}
