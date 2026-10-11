// SPDX-License-Identifier: Apache-2.0

/** A value JSON carries. */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * Text form of a JSON value: strings pass through, anything else is JSON-encoded
 * (`String({})` is `[object Object]`, `String(["a,b"])` is ambiguous).
 */
export function jsonText(value: JsonValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
