// SPDX-License-Identifier: Apache-2.0

/** A non-null, non-array object. Internal: not in the package's `exports`. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
