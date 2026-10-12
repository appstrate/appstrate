// SPDX-License-Identifier: Apache-2.0

/**
 * Text form of a JSON value: strings pass through, anything else is JSON-encoded
 * (`String({})` is `[object Object]`, `String(["a,b"])` is ambiguous). `undefined` is not a JSON
 * value and does not typecheck.
 */
export function jsonText(value: NonNullable<unknown> | null): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** {@link jsonText} of each value of a bag; a `null` or `undefined` one is absent and left out. */
export function jsonTextMap(values: Readonly<Record<string, unknown>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== null && value !== undefined) out[key] = jsonText(value);
  }
  return out;
}
