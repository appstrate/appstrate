// SPDX-License-Identifier: Apache-2.0

/**
 * Text form of an arbitrary JSON value: strings pass through unchanged,
 * everything else is JSON-encoded so a reader can recover the value
 * unambiguously (`String({})` yields `[object Object]`, and `String(["a,b"])`
 * is indistinguishable from `["a", "b"]`). Numbers, booleans and `null` read
 * exactly as `String()` would. `undefined` is excluded by the type because
 * `JSON.stringify(undefined)` is `undefined`.
 */
export function jsonText(value: NonNullable<unknown> | null): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
