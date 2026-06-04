// Copyright 2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * Companion-file enforcement, re-exported from the shared zero-dependency
 * `@appstrate/afps-shared` package so the platform's ZIP-import path
 * (`@appstrate/core/zip:parsePackageZip`) and the runtime's bundle loader
 * (`@appstrate/afps-runtime/bundle/companion-files`) share one source of
 * truth and can never drift.
 *
 * The public `@appstrate/core/companion-files` subpath surface is preserved
 * verbatim — only the implementation moved.
 */

export {
  type CompanionViolationReason,
  type CompanionFileViolation,
  type CompanionFileSource,
  companionFilesFromMap,
  companionFilesFromRecord,
  checkCompanionFiles,
} from "@appstrate/afps-shared/companion-files";
