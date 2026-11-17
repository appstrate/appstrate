// SPDX-License-Identifier: Apache-2.0

/** Detail pages are org-scoped server-side, so anything but a read-only system package is the org's. */
export function isOwnedSource(source: string | undefined): boolean {
  return source !== "system";
}
