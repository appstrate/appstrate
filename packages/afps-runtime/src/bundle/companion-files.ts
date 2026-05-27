// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Companion-file enforcement for the `.afps` / `.afps-bundle` loader paths.
 *
 * The §3.3 / §3.4 invariants live once in `@appstrate/afps-shared`; this
 * module is a thin Map-accepting adapter that throws a runtime
 * {@link BundleError} on violation. Both the platform's ZIP-import path and
 * this loader path therefore reject the same inputs from a single source.
 *
 * Spec references: §3.3 (skill SKILL.md + frontmatter `name`), §3.4 (agent
 * prompt.md non-empty; mcp-server `server.entry_point` payload present in
 * the archive).
 */

import {
  checkCompanionFiles as checkCompanionFilesShared,
  companionFilesFromMap,
  type CompanionFileViolation,
} from "@appstrate/afps-shared/companion-files";

import { BundleError } from "./errors.ts";

export type {
  CompanionViolationReason,
  CompanionFileViolation,
} from "@appstrate/afps-shared/companion-files";

/**
 * Validate companion-file presence per AFPS §3.3 / §3.4 for the given
 * package type. Returns the first violation or `null`. Map-based adapter
 * over the shared `checkCompanionFiles`.
 */
export function checkCompanionFiles(
  manifest: { type?: unknown; server?: unknown } & Record<string, unknown>,
  files: Map<string, Uint8Array>,
): CompanionFileViolation | null {
  return checkCompanionFilesShared(manifest, companionFilesFromMap(files));
}

/**
 * Convenience wrapper: run {@link checkCompanionFiles} and throw a
 * structured {@link BundleError} on violation. Both single-package
 * `.afps` and multi-package `.afps-bundle` callers use this so the error
 * surface is uniform.
 */
export function assertCompanionFiles(
  manifest: { type?: unknown; server?: unknown } & Record<string, unknown>,
  files: Map<string, Uint8Array>,
): void {
  const violation = checkCompanionFiles(manifest, files);
  if (!violation) return;
  throw new BundleError("ARCHIVE_INVALID", violation.message, {
    reason: violation.reason,
    path: violation.path,
  });
}
