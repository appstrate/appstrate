// SPDX-License-Identifier: Apache-2.0

/** A JSON value with its object keys sorted at every depth: two equal values give one string. */
export function stableJson(value: unknown, indent?: number): string | undefined {
  return JSON.stringify(
    value,
    (_key, v: unknown) =>
      v && typeof v === "object" && !Array.isArray(v)
        ? Object.fromEntries(
            Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
              a < b ? -1 : a > b ? 1 : 0,
            ),
          )
        : v,
    indent,
  );
}
