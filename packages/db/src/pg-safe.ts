// SPDX-License-Identifier: Apache-2.0

/**
 * Deep-copy a JSON value so PostgreSQL can store every string in it, keys
 * included: NULs and lone UTF-16 surrogates (refused by `text`/`jsonb`, and
 * identically on every retry — #1501) become U+FFFD, so the gap stays visible.
 */
export function toPgSafe<T>(value: T): T {
  return sanitize(value) as T;
}

function sanitize(value: unknown): unknown {
  if (typeof value === "string") return sanitizeString(value);
  if (Array.isArray(value)) return value.map(sanitize);
  if (isPlainObject(value)) {
    // `fromEntries` defines own properties, so a parsed `"__proto__"` key stays data.
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [sanitizeString(key), sanitize(v)]),
    );
  }
  return value;
}

function sanitizeString(s: string): string {
  if (!s.includes("\u0000") && s.isWellFormed()) return s;
  return s.toWellFormed().replaceAll("\u0000", "\uFFFD");
}

/** Dates, Maps, buffers, class instances keep their own `toJSON`/driver encoding. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
