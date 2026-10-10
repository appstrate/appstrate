// SPDX-License-Identifier: Apache-2.0

/**
 * Text form of an arbitrary JSON value: strings pass through unchanged,
 * everything else is JSON-encoded so a reader can recover the value
 * unambiguously (`String({})` yields `[object Object]`, and `String(["a,b"])`
 * is indistinguishable from `["a", "b"]`). Numbers, booleans and `null` read
 * exactly as `String()` would. `value` is a JSON value: `undefined` (and other
 * non-JSON values) make `JSON.stringify` return `undefined`, so callers handle
 * those themselves.
 */
export function jsonText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
