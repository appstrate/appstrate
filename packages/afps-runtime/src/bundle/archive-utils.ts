// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Shared ZIP entry sanitization for the `.afps-bundle` and single-package
 * `.afps` readers. Centralizes the path-safety rules so we don't
 * re-implement them.
 */

import type { DecompressionLimitError } from "@appstrate/afps-shared/unzip-bounded";

import { BundleError } from "./errors.ts";
import type { BundleLimits } from "./limits.ts";

const INVALID_SEGMENT = /[\0]/;
/**
 * Characters that must never appear in an entry name because they are
 * delimiters in the signature RECORD (one `path,sha256,bytes` line per
 * entry). A comma or CR/LF in a filename could forge or split a RECORD
 * line (line-injection), desynchronising the integrity manifest.
 */
const RECORD_DELIMITER = /[\r\n,]/;
/**
 * Windows drive prefix (`C:/…`). Absolute on the extraction target, yet every
 * segment reads as relative, so the traversal loop below cannot catch it.
 */
const DRIVE_PREFIX = /^[a-zA-Z]:\//;

export interface SanitizeOptions {
  limits: BundleLimits;
  /** Label to prefix path-related error messages. */
  context?: string;
}

/**
 * Return a sanitized, depth-checked copy of the input map. Drops
 * directory entries (keys ending with `/`) and `__MACOSX/*` noise.
 * Rejects path-traversal (`..`, `.`, empty segments), absolute paths in BOTH
 * spellings (leading `/` and a `C:/` drive prefix), backslashes, null bytes,
 * signature-RECORD delimiters (comma, CR, LF) and a `__proto__` segment.
 *
 * That list is deliberately the same set `isSafeArchivePath`
 * (`@appstrate/core/zip`) refuses — only the REACTION differs (throw here, drop
 * there). `packages/core/test/sanitizer-parity.test.ts` runs both over one
 * shared table of shapes and fails on any disagreement.
 */
export function sanitizeEntries(
  raw: Record<string, Uint8Array>,
  opts: SanitizeOptions,
): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const ctx = opts.context ?? "archive";
  for (const [key, value] of Object.entries(raw)) {
    if (key.endsWith("/")) continue;
    if (key.startsWith("__MACOSX/")) continue;
    if (key.length === 0) continue;

    if (key.startsWith("/")) {
      throw new BundleError("ARCHIVE_INVALID", `${ctx}: absolute path not allowed: ${key}`);
    }
    // A Windows drive prefix is the second spelling of "absolute", and the one
    // the segment loop below structurally cannot see: `C:/notes.md` splits into
    // `["C:", "notes.md"]`, neither empty nor `.` nor `..`. The platform's own
    // gate (`isSafeArchivePath`, `@appstrate/core/zip`) has always refused it,
    // so accepting it here meant an imported `.afps` kept an entry in the
    // rebuilt, frozen artifact that the platform's file index had dropped — two
    // views of one package disagreeing with nothing reporting it.
    if (DRIVE_PREFIX.test(key)) {
      throw new BundleError("ARCHIVE_INVALID", `${ctx}: absolute path not allowed: ${key}`);
    }
    if (key.includes("\\")) {
      throw new BundleError("ARCHIVE_INVALID", `${ctx}: backslash in path not allowed: ${key}`);
    }
    if (INVALID_SEGMENT.test(key)) {
      throw new BundleError("ARCHIVE_INVALID", `${ctx}: null byte in path: ${key}`);
    }
    if (RECORD_DELIMITER.test(key)) {
      throw new BundleError(
        "ARCHIVE_INVALID",
        `${ctx}: comma or newline in path not allowed: ${key}`,
      );
    }
    const segments = key.split("/");
    if (segments.some((s) => s === "" || s === "." || s === "..")) {
      throw new BundleError("ARCHIVE_INVALID", `${ctx}: path traversal not allowed: ${key}`);
    }
    // Not a traversal, and harmless to THIS function — the result is a `Map`,
    // which has no magic keys. It is refused because the platform refuses it
    // (`isSafeArchivePath` and `assertPath`, `@appstrate/core`): an entry this
    // reader admitted and the platform dropped is a bundle whose rebuilt
    // artifact and whose file index disagree. One rule, or the two halves drift.
    if (segments.includes("__proto__")) {
      throw new BundleError("ARCHIVE_INVALID", `${ctx}: reserved segment in path: ${key}`);
    }
    if (segments.length > opts.limits.maxPathDepth) {
      throw new BundleError(
        "LIMITS_EXCEEDED",
        `${ctx}: path depth ${segments.length} exceeds limit ${opts.limits.maxPathDepth}`,
        { field: "pathDepth", path: key },
      );
    }
    if (value.length > opts.limits.maxFileBytes) {
      throw new BundleError(
        "LIMITS_EXCEEDED",
        `${ctx}: file ${key} (${value.length} bytes) exceeds per-file limit ${opts.limits.maxFileBytes}`,
        { field: "fileBytes", path: key, bytes: value.length },
      );
    }
    out.set(key, value);
  }
  return out;
}

/**
 * If every entry shares a single top-level directory, strip it. Used for
 * user-authored AFPS ZIPs whose tools add a wrapper folder.
 *
 * Re-exported from `@appstrate/afps-shared/archive-prefix`, which owns the one
 * implementation this package and `@appstrate/core/zip` both read. It used to
 * be a hand-copy of core's `Map` branch under a comment asking a human to keep
 * the two algorithms in sync — the justification being that this package
 * intentionally carries no `@appstrate/core` runtime dependency, which is
 * precisely the question `@appstrate/afps-shared` exists to answer (both
 * packages already depend on it).
 */
export { stripWrapperPrefix } from "@appstrate/afps-shared/archive-prefix";

/** Sum of decompressed sizes for budget checks. */
export function sumSizes(files: Map<string, Uint8Array> | Record<string, Uint8Array>): number {
  let total = 0;
  if (files instanceof Map) {
    for (const v of files.values()) total += v.length;
  } else {
    for (const v of Object.values(files)) total += v.length;
  }
  return total;
}

/**
 * Map a mid-inflate {@link DecompressionLimitError} onto the {@link BundleError}
 * shape the bundle builder and the bundle readers already throw. A
 * `corrupt-archive` reason surfaces as `ARCHIVE_INVALID` (matching the previous
 * decompress-failure branch); the three resource-budget reasons surface as
 * `LIMITS_EXCEEDED` with a `field` mirroring the post-hoc checks they replace.
 *
 * Lives here rather than in `build.ts` and `read.ts`: both inflate through
 * `unzipBounded` and both have to turn the same four reasons into the same four
 * `BundleError`s, and the two module-private copies this replaces were byte
 * identical apart from one word of prose.
 */
export function decompressionLimitToBundleError(
  err: DecompressionLimitError,
  context: string,
): BundleError {
  if (err.reason === "corrupt-archive") {
    return new BundleError("ARCHIVE_INVALID", `failed to decompress ${context}: ${err.message}`);
  }
  const field =
    err.reason === "too-many-files"
      ? "files"
      : err.reason === "file-too-large"
        ? "fileBytes"
        : "decompressedBytes";
  return new BundleError("LIMITS_EXCEEDED", err.message, { field });
}
