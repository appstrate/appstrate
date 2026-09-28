// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

import {
  computeIntegrity,
  verifyIntegrity,
  type IntegrityCheckResult,
} from "@appstrate/afps-shared/integrity";

import { stripScope } from "./naming.ts";

// SRI primitives moved to the shared zero-dependency `@appstrate/afps-shared`
// package so the platform and the standalone `afps` CLI share one
// implementation. The `@appstrate/core/integrity` public surface is preserved:
// `computeIntegrity`, `IntegrityCheckResult`, and `verifyArtifactIntegrity`
// (an alias of the shared `verifyIntegrity`).
export { computeIntegrity, type IntegrityCheckResult };

/**
 * Verify artifact integrity by computing SHA256 hash and comparing to the
 * expected value. Alias for the shared `verifyIntegrity` — preserves the
 * historical `@appstrate/core/integrity` export name.
 */
export const verifyArtifactIntegrity = verifyIntegrity;

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

/**
 * Input for building standard package download response headers — a published
 * VERSION, which always carries its SRI digest, or the DRAFT, which is no
 * immutable artifact and has none. Two shapes rather than an optional digest,
 * so a version cannot be served without `X-Integrity` by omission.
 */
export type DownloadHeadersInput =
  | {
      /** Semver version string. */
      version: string;
      /** SRI integrity hash of the artifact. */
      integrity: string;
      /** Whether the version has been yanked. */
      yanked: boolean;
      /** Package scope (e.g. "@myorg"). */
      scope: string;
      /** Package name without scope. */
      name: string;
    }
  | { version: "draft"; scope: string; name: string };

/** Build standard download response headers (Content-Type, Content-Disposition, X-Integrity, X-Yanked). */
export function buildDownloadHeaders(meta: DownloadHeadersInput): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/afps+zip",
    "Content-Disposition": `attachment; filename="${buildDownloadFilename(meta.scope, meta.name, meta.version)}"`,
  };
  if ("integrity" in meta) {
    headers["X-Integrity"] = meta.integrity;
    if (meta.yanked) headers["X-Yanked"] = "true";
  }
  return headers;
}
