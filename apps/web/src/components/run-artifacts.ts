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
 * The list of LOST deliverables, returned ONLY when the run's outputs sweep is
 * genuinely `partial` (at least one failure); `null` otherwise, so the banner
 * renders nothing. The summary is fully described by the run DTO
 * (`RunArtifactsSummary | null`) — no re-narrowing of an `unknown` blob, which
 * only hid where the shape would drift. Pure — unit-tested without a DOM.
 */
export function partialArtifactFailures(
  artifacts: RunArtifactsSummary | null | undefined,
): RunArtifactsSummary["failed"] | null {
  if (!artifacts || artifacts.status !== "partial") return null;
  return artifacts.failed.length > 0 ? artifacts.failed : null;
}
