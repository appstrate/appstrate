// SPDX-License-Identifier: Apache-2.0
export { asRecord } from "@appstrate/core/api-errors";

/** Safely narrow a JSONB value to a record, returning null if not a plain object. */
export function asRecordOrNull(val: unknown): Record<string, unknown> | null {
  return val !== null && typeof val === "object" && !Array.isArray(val)
    ? (val as Record<string, unknown>)
    : null;
}
