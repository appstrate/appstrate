// SPDX-License-Identifier: Apache-2.0

/**
 * Text form of a JSON value: strings pass through, anything else is JSON-encoded
 * (`String({})` is `[object Object]`, `String(["a,b"])` is ambiguous). Absent values render as "".
 */
export function jsonText(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value) ?? "");
}
