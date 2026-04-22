// SPDX-License-Identifier: Apache-2.0

/**
 * JSONB narrowing helpers for safely consuming opaque JSON columns and
 * untyped manifest payloads. Pure runtime predicates — no external deps.
 */

/** Narrow a JSONB value to a record, returning {} if null/non-object/array. */
export function asRecord(val: unknown): Record<string, unknown> {
  return val !== null && typeof val === "object" && !Array.isArray(val)
    ? (val as Record<string, unknown>)
    : {};
}

/** Narrow a JSONB value to a record, returning null if not a plain object. */
export function asRecordOrNull(val: unknown): Record<string, unknown> | null {
  return val !== null && typeof val === "object" && !Array.isArray(val)
    ? (val as Record<string, unknown>)
    : null;
}

/** Type guard — `true` for values that are plain objects (not arrays, not null). */
export function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}
