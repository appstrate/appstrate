// SPDX-License-Identifier: Apache-2.0

import { sanitizeFilename } from "@appstrate/core/naming";

/**
 * Reduce a display name to an ASCII-only storage key segment.
 *
 * Two steps, and both call sites always wanted both: `sanitizeFilename` strips
 * directory separators, control characters and `..` traversal and caps the
 * length; the fold below then removes diacritics and replaces everything left
 * outside `[A-Za-z0-9._-]` so the result survives every storage backend's key
 * rules unchanged (S3/MinIO/R2 and the filesystem driver alike).
 *
 * Composed here rather than left to each caller because the ordering matters:
 * folding first would turn a separator into `_` and hide it from the traversal
 * guard.
 */
export function toStorageName(name: string): string {
  return sanitizeFilename(name)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics
    .replace(/[^a-zA-Z0-9._-]/g, "_"); // replace remaining non-ASCII / special chars
}
