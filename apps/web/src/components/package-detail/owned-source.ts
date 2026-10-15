// SPDX-License-Identifier: Apache-2.0

/**
 * Whether the org owns the package row. Every package a detail page reads is
 * already org-scoped server-side, so anything that is not a read-only system
 * package is freely editable and deletable.
 */
export function isOwnedSource(source: string | undefined): boolean {
  return source !== "system";
}
