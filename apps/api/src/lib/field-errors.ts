// SPDX-License-Identifier: Apache-2.0

/**
 * Shared parser for the `"path: message"` error strings produced by
 * `@appstrate/core/validation` helpers (`validateManifest`,
 * `validateInlineManifest`, …).
 *
 * Both `routes/packages.ts` and `services/inline-run-preflight.ts` ingest
 * these strings and need to fold them into RFC 9457 `ValidationFieldError`
 * entries. Keeping the split logic here avoids drift — the regex deliberately
 * anchors on a strict path-like prefix (alphanumerics, dots, brackets) so
 * messages containing `": "` (quoted regex patterns, nested examples) are
 * never truncated mid-string.
 */

import type { ValidationFieldError } from "./errors.ts";

const PATH_PREFIX_RE = /^([A-Za-z_][A-Za-z0-9_.[\]]*): (.+)$/s;

export interface PathMessageParseOptions {
  /** `code` attached to every generated entry. */
  code: string;
  /** `title` attached to every generated entry. */
  title: string;
  /**
   * Prefix prepended to the parsed path. Use `"manifest."` when the raw
   * strings omit the top-level qualifier (e.g. direct output of
   * `validateManifest`). Leave empty when the caller already prefixes the
   * path upstream (e.g. `validateInlineManifest`).
   */
  fieldPrefix?: string;
  /**
   * Field name to use when the raw string has no path-like prefix. Defaults
   * to `"manifest"` — the common case for both callers today.
   */
  fallbackField?: string;
}

/** Parse a single `"path: message"` string into a structured field error. */
export function parsePathMessage(raw: string, opts: PathMessageParseOptions): ValidationFieldError {
  const { code, title, fieldPrefix = "", fallbackField = "manifest" } = opts;
  const match = PATH_PREFIX_RE.exec(raw);
  if (!match) return { field: fallbackField, code, title, message: raw };
  return { field: `${fieldPrefix}${match[1]!}`, code, title, message: match[2]! };
}

/** Parse every `"path: message"` string in the array. */
export function parsePathMessages(
  errors: readonly string[],
  opts: PathMessageParseOptions,
): ValidationFieldError[] {
  return errors.map((raw) => parsePathMessage(raw, opts));
}
