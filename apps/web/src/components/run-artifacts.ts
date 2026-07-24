// SPDX-License-Identifier: Apache-2.0

/**
 * Pure helpers for the run "partial deliverables" banner. Kept in a non-JSX
 * module (separate from `run-artifacts-banner.tsx`) so the component file only
 * exports a component (react-refresh) and so these can be unit-tested without a
 * DOM.
 */

import type { RunArtifactsSummary } from "@appstrate/shared-types";

/**
 * The failure codes the container's outputs sweep reports (see
 * `runtime-pi/publish.ts` `UploadFailureCode` and the `oversized` promotion in
 * `summarizeArtifacts`). Each maps to a `run.artifacts.code.<code>` i18n key;
 * an unrecognised code falls back to `run.artifacts.code.unknown` so a new
 * runner-side code never renders a raw key.
 */
const KNOWN_FAILURE_CODES = new Set([
  "file_too_large",
  "quota_exceeded",
  "conflict",
  "upload_failed",
]);

/** The `run.artifacts.code.<suffix>` i18n key for a failure code. */
export function artifactFailureCodeKey(code: string): string {
  return `run.artifacts.code.${KNOWN_FAILURE_CODES.has(code) ? code : "unknown"}`;
}

/**
 * Safe-narrow the untyped `run.artifacts` blob to the list of LOST deliverables,
 * returning it ONLY when the run is genuinely `partial` (at least one failure).
 * Returns `null` for a null/complete/malformed summary so the banner renders
 * nothing. Pure — unit-tested without a DOM.
 */
export function partialArtifactFailures(
  artifacts: unknown,
): Array<{ name: string; code: string }> | null {
  if (artifacts == null || typeof artifacts !== "object") return null;
  const a = artifacts as Partial<RunArtifactsSummary>;
  if (a.status !== "partial") return null;
  if (!Array.isArray(a.failed) || a.failed.length === 0) return null;
  return a.failed.filter(
    (f): f is { name: string; code: string } =>
      !!f && typeof f.name === "string" && typeof f.code === "string",
  );
}
