// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Shared ZIP entry sanitization for the `.afps-bundle` and single-package
 * `.afps` readers. Centralizes the path-safety rules so we don't
 * re-implement them.
 */

import { BundleError } from "./errors.ts";
import type { BundleLimits } from "./limits.ts";

const INVALID_SEGMENT = /[\0]/;

export interface SanitizeOptions {
  limits: BundleLimits;
  /** Label to prefix path-related error messages. */
  context?: string;
}

/**
 * Return a sanitized, depth-checked copy of the input map. Drops
 * directory entries (keys ending with `/`) and `__MACOSX/*` noise.
 * Rejects path-traversal, absolute paths, backslashes, null bytes.
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
    if (key.includes("\\")) {
      throw new BundleError("ARCHIVE_INVALID", `${ctx}: backslash in path not allowed: ${key}`);
    }
    if (INVALID_SEGMENT.test(key)) {
      throw new BundleError("ARCHIVE_INVALID", `${ctx}: null byte in path: ${key}`);
    }
    const segments = key.split("/");
    if (segments.some((s) => s === "" || s === "." || s === "..")) {
      throw new BundleError("ARCHIVE_INVALID", `${ctx}: path traversal not allowed: ${key}`);
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
 * Mirror of `stripWrapperPrefix` in `@appstrate/core/zip` (Record + Map
 * generic). This package intentionally avoids an `@appstrate/core` runtime
 * dependency to stay portable + standalone, so we maintain a local Map-only
 * copy. Keep the two algorithms in sync.
 */
export function stripWrapperPrefix(files: Map<string, Uint8Array>): Map<string, Uint8Array> {
  if (files.size === 0) return files;
  const prefixes = new Set<string>();
  for (const key of files.keys()) {
    const slash = key.indexOf("/");
    if (slash === -1) return files;
    prefixes.add(key.slice(0, slash));
  }
  if (prefixes.size !== 1) return files;
  const prefix = `${[...prefixes][0]!}/`;
  const stripped = new Map<string, Uint8Array>();
  for (const [key, value] of files) {
    stripped.set(key.slice(prefix.length), value);
  }
  return stripped;
}

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
