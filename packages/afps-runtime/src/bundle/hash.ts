// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Compute a Subresource Integrity (SRI) hash for binary data.
 *
 * Returns a string in the canonical SRI form (`sha256-<base64>`), directly
 * usable in `X-Integrity` HTTP headers, HTML `integrity` attributes, and
 * signed bundle manifests.
 *
 * @param data - Binary content to hash.
 * @returns SRI string, e.g. `"sha256-pIT…="`.
 */
export function computeIntegrity(data: Uint8Array): string {
  const hash = createHash("sha256");
  hash.update(data);
  return `sha256-${hash.digest("base64")}`;
}

export interface IntegrityCheckResult {
  /** Whether the computed hash matches `expected` exactly. */
  valid: boolean;
  /** The hash we computed from `data`. Useful for error reporting. */
  computed: string;
}

/**
 * Verify binary data against an expected SRI hash.
 *
 * Comparison is constant-time when the lengths match — a short-circuit
 * on mismatched lengths is safe because SRI strings of a given algorithm
 * have a fixed length, and we don't leak anything an attacker couldn't
 * derive from the algorithm prefix.
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
