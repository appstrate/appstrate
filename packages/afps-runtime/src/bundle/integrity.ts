// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Integrity computation for the Bundle contract.
 *
 * Two encoding conventions coexist, matching the spec §4.5:
 *
 *   - Inside a `RECORD` file, per-file hashes use
 *     `sha256=<base64-no-padding>` (PEP 427 style).
 *   - `bundle.json.integrity` and per-package `integrity` use
 *     `sha256-<base64-padded>` (W3C SRI).
 */

import { createHash } from "node:crypto";
import { canonicalJsonStringify } from "./canonical-json.ts";
import { BundleError } from "./errors.ts";
import type { PackageIdentity } from "./types.ts";

/** Per-file entry inside a `RECORD` file. */
export interface RecordEntry {
  /** Posix-normalized path relative to the package directory. */
  path: string;
  /** Raw SHA-256 hash, encoded as `sha256=<base64-no-padding>`. */
  hash: string;
  /** Decompressed size in bytes. */
  size: number;
}

function sha256Bytes(data: Uint8Array): Buffer {
  const h = createHash("sha256");
  h.update(data);
  return h.digest();
}

function base64NoPad(buf: Buffer): string {
  return buf.toString("base64").replace(/=+$/, "");
}

function base64Padded(buf: Buffer): string {
  return buf.toString("base64");
}

/**
 * Hash a single file. Returns the PEP 427-style `sha256=<b64-no-pad>`
 * form used inside RECORD lines.
 */
export function recordFileHash(data: Uint8Array): string {
  return `sha256=${base64NoPad(sha256Bytes(data))}`;
}

/**
 * Build a canonical RECORD body from an iterable of entries.
 *
 * Format per spec §4.5:
 *  - one line per file: `<path>,<hash>,<size>`
 *  - sorted lexicographically by path
 *  - LF line endings, single trailing newline
 *  - excludes the RECORD file itself (callers must not pass it)
 */
export function serializeRecord(entries: readonly RecordEntry[]): string {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const entry of sorted) {
    if (seen.has(entry.path)) {
      throw new BundleError("RECORD_MALFORMED", `duplicate RECORD entry for path: ${entry.path}`, {
        path: entry.path,
      });
    }
    seen.add(entry.path);
    lines.push(`${entry.path},${entry.hash},${entry.size}`);
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/**
 * Parse a RECORD body into entries. Strict: rejects duplicate paths,
 * malformed lines, and non-LF line endings (the closing `\n` is
 * tolerated; any other occurrence of `\r` fails).
 */
export function parseRecord(body: string): RecordEntry[] {
  if (body.includes("\r")) {
    throw new BundleError("RECORD_MALFORMED", "RECORD contains CR characters (must be LF-only)");
  }
  const trimmed = body.endsWith("\n") ? body.slice(0, -1) : body;
  if (trimmed === "") return [];
  const entries: RecordEntry[] = [];
  const seen = new Set<string>();
  for (const line of trimmed.split("\n")) {
    const parts = line.split(",");
    if (parts.length !== 3) {
      throw new BundleError("RECORD_MALFORMED", `malformed RECORD line: ${JSON.stringify(line)}`);
    }
    const [path, hash, sizeStr] = parts as [string, string, string];
    if (!path || !hash.startsWith("sha256=") || hash.length <= "sha256=".length) {
      throw new BundleError("RECORD_MALFORMED", `malformed RECORD line: ${JSON.stringify(line)}`);
    }
    const size = Number(sizeStr);
    if (!Number.isInteger(size) || size < 0) {
      throw new BundleError(
        "RECORD_MALFORMED",
        `malformed RECORD size: ${JSON.stringify(sizeStr)}`,
      );
    }
    if (seen.has(path)) {
      throw new BundleError("RECORD_MALFORMED", `duplicate RECORD entry for path: ${path}`, {
        path,
      });
    }
    seen.add(path);
    entries.push({ path, hash, size });
  }
  return entries;
}

/**
 * Compute RECORD entries from a file map. The map's keys are
 * already-sanitized, package-relative posix paths. The `RECORD` file
 * itself is omitted from the result (it cannot hash itself).
 */
export function computeRecordEntries(files: Map<string, Uint8Array>): RecordEntry[] {
  const entries: RecordEntry[] = [];
  for (const [path, data] of files) {
    if (path === "RECORD") continue;
    entries.push({
      path,
      hash: recordFileHash(data),
      size: data.length,
    });
  }
  return entries;
}

/**
 * SRI hash over the canonical RECORD bytes — this is the
 * per-package `integrity` value that goes into `bundle.json`.
 */
export function recordIntegrity(recordBody: string): string {
  const bytes = new TextEncoder().encode(recordBody);
  return `sha256-${base64Padded(sha256Bytes(bytes))}`;
}

/**
 * SRI hash over the canonical serialization of the packages map.
 * Matches `bundle.json.integrity`. The `metadata` field is intentionally
 * excluded (see spec §4.5).
 */
export function bundleIntegrity(
  packages: Map<PackageIdentity, { path: string; integrity: string }>,
): string {
  // Sort identities; for each, emit `{path, integrity}` — keys are sorted
  // by canonicalJsonStringify.
  const sortedIds = [...packages.keys()].sort();
  const obj: Record<string, { path: string; integrity: string }> = {};
  for (const id of sortedIds) {
    obj[id] = packages.get(id)!;
  }
  const canonical = canonicalJsonStringify(obj);
  const bytes = new TextEncoder().encode(canonical);
  return `sha256-${base64Padded(sha256Bytes(bytes))}`;
}

/**
 * Verify `computed === expected` using a timing-safe comparison when the
 * lengths match. Both strings must be pre-encoded SRI (`sha256-…`).
 */
export function integrityEqual(computed: string, expected: string): boolean {
  if (computed.length !== expected.length) return false;
  const a = Buffer.from(computed, "utf8");
  const b = Buffer.from(expected, "utf8");
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
