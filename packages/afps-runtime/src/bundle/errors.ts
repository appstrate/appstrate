// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Stable, machine-readable error codes raised by the bundle runtime.
 *
 * These codes are part of the public API — consumers may branch on them
 * to map to HTTP status codes or UI messages. Do not rename; add new
 * variants via a MINOR version bump.
 */
export type BundleErrorCode =
  | "ARCHIVE_INVALID"
  | "BUNDLE_JSON_MISSING"
  | "BUNDLE_JSON_INVALID"
  | "RECORD_MISSING"
  | "RECORD_MALFORMED"
  | "RECORD_MISMATCH"
  | "INTEGRITY_MISMATCH"
  | "VERSION_UNSUPPORTED"
  | "LIMITS_EXCEEDED"
  | "MANIFEST_SCHEMA"
  | "DEPENDENCY_UNRESOLVED";

/**
 * Domain error for the bundle runtime. Carries a stable `code` plus
 * optional structured `details` for precise diagnostics (e.g. the exact
 * file path that failed integrity).
 */
export class BundleError extends Error {
  readonly code: BundleErrorCode;
  readonly details?: unknown;

  constructor(code: BundleErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "BundleError";
    this.code = code;
    this.details = details;
  }
}
