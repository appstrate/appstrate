// SPDX-License-Identifier: Apache-2.0

import { PackageFileWriteError } from "@appstrate/core/package-file-operations";
import { PACKAGE_CONTENT_FILE } from "@appstrate/core/package-files";
import type { PackageType } from "@appstrate/core/validation";
import { ApiError } from "../api/errors";

/** The file each package type's substance lives in, from `PACKAGE_CONTENT_FILE` (shared with the ZIP parser). */
export function primaryDisplayFile(type: PackageType): { name: string } {
  return { name: PACKAGE_CONTENT_FILE[type] };
}

/** The three path refusals of a draft-tree write: the one sentence of each code, here and in `errorMessage`. */
export const PACKAGE_PATH_ERROR_KEYS = {
  invalid_path: "files.errorInvalidPath",
  reserved_entry: "files.errorReserved",
  path_conflict: "files.errorConflictPath",
} as const;

/**
 * The message key for a refused draft-tree write, keyed by the route's `code`, or
 * `null` for a failure this surface does not own. `null` is load-bearing: the same
 * save sends the files AND the manifest and the banner asks both translators, so a
 * blanket message would swallow the manifest's specific ones.
 *
 * `content_entry_immovable` and `not_found` are deliberately absent: the tree
 * cannot provoke them, so they mean the client's picture is wrong.
 */
export function packageFilesErrorKey(error: unknown): string | null {
  if (!(error instanceof ApiError) && !(error instanceof PackageFileWriteError)) return null;
  switch (error.code) {
    // The tree moved under this editor: the fix is to re-read it, and the
    // buffered edits are kept so the author can save them again.
    case "precondition_failed":
      return "files.errorConflict";
    case "invalid_path":
    case "reserved_entry":
    case "path_conflict":
      return PACKAGE_PATH_ERROR_KEYS[error.code];
    // `payload_too_large` is the global body-limit middleware: near-1 MiB files
    // inflate ~1.37x as base64 and cross `API_BODY_LIMIT_BYTES` under the per-file ceiling.
    case "file_too_large":
    case "tree_too_large":
    case "payload_too_large":
      return "files.errorTooLarge";
    default:
      return null;
  }
}
