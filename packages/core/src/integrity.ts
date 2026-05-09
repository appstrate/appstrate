// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

import { timingSafeEqual } from "node:crypto";

import { stripScope } from "./naming.ts";

/**
 * Compute a Subresource Integrity (SRI) hash for binary data.
 * @param data - Binary content to hash
 * @returns SRI string in the format "sha256-{base64}"
 */
export function computeIntegrity(data: Uint8Array | Buffer): string {
  const hash = new Bun.CryptoHasher("sha256");
  hash.update(data);
  const base64 = hash.digest("base64");
  return `sha256-${base64}`;
}

// ─────────────────────────────────────────────
// Integrity verification
// ─────────────────────────────────────────────

/** Result of an integrity verification check. */
export interface IntegrityCheckResult {
  /** Whether the computed hash matches the expected value. */
  valid: boolean;
  /** The computed SRI hash string. */
  computed: string;
}

/**
 * Verify artifact integrity by computing SHA256 hash and comparing to expected value.
 *
 * Comparison is constant-time when the lengths match — a short-circuit on
 * mismatched lengths is safe because SRI strings of a given algorithm have a
 * fixed length, and the length itself is not a secret.
 */
export function verifyArtifactIntegrity(
  data: Uint8Array,
  expectedIntegrity: string,
): IntegrityCheckResult {
  const computed = computeIntegrity(data);
  if (computed.length !== expectedIntegrity.length) {
    return { valid: false, computed };
  }
  const a = Buffer.from(computed, "utf8");
  const b = Buffer.from(expectedIntegrity, "utf8");
  return { valid: timingSafeEqual(a, b), computed };
}

// ─────────────────────────────────────────────
// Download filename
// ─────────────────────────────────────────────

/** Build a consistent download filename: scope-name-version.afps */
function buildDownloadFilename(scope: string, name: string, version: string): string {
  return `${stripScope(scope)}-${name}-${version}.afps`;
}

// ─────────────────────────────────────────────
// Download response headers
// ─────────────────────────────────────────────

/** Input for building standard package download response headers. */
export interface DownloadHeadersInput {
  /** SRI integrity hash of the artifact. */
  integrity: string;
  /** Whether the version has been yanked. */
  yanked: boolean;
  /** Package scope (e.g. "@myorg"). */
  scope: string;
  /** Package name without scope. */
  name: string;
  /** Semver version string. */
  version: string;
}

/** Build standard download response headers (Content-Type, Content-Disposition, X-Integrity, X-Yanked). */
export function buildDownloadHeaders(meta: DownloadHeadersInput): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/afps+zip",
    "X-Integrity": meta.integrity,
    "Content-Disposition": `attachment; filename="${buildDownloadFilename(meta.scope, meta.name, meta.version)}"`,
  };
  if (meta.yanked) {
    headers["X-Yanked"] = "true";
  }
  return headers;
}
