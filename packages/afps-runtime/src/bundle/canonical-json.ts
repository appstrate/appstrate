// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Deterministic JSON canonicalization used for integrity hashing.
 *
 * Rules:
 * - Object keys sorted lexicographically by UTF-16 code point
 * - No whitespace
 * - Arrays preserve order
 * - Primitives serialized via {@link JSON.stringify}
 *
 * Throws on `undefined` in value position, `NaN`/`Infinity`, or functions
 * — these have no canonical JSON representation and indicate a bug.
 */
export function canonicalJsonStringify(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`cannot canonicalize non-finite number: ${String(value)}`);
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    const parts = value.map(serialize);
    return `[${parts.join(",")}]`;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const v = obj[key];
      if (v === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${serialize(v)}`);
    }
    return `{${parts.join(",")}}`;
  }
  throw new TypeError(`cannot canonicalize value of type ${typeof value}`);
}
