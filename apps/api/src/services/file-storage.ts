// SPDX-License-Identifier: Apache-2.0

/** Sanitize filename for storage (ASCII-only keys). */
export function sanitizeStorageKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics
    .replace(/[^a-zA-Z0-9._-]/g, "_"); // replace remaining non-ASCII / special chars
}
