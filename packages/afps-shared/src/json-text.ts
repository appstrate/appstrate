// SPDX-License-Identifier: Apache-2.0

/**
 * Text form of a JSON value: strings pass through, anything else is JSON-encoded
 * (`String({})` is `[object Object]`, `String(["a,b"])` is ambiguous). `undefined` is not a JSON
 * value and does not typecheck.
 */
export function jsonText(value: NonNullable<unknown> | null): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
