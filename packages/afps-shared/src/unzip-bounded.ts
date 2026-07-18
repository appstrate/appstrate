// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * Memory-bounded ZIP decompression — the single primitive for ingesting
 * untrusted archives (AFPS bundles, package ZIPs, integration bundles).
 *
 * The prior pattern everywhere was `unzipSync(archive)` (fflate, fully
 * synchronous) followed by a `sumSizes(...) > maxDecompressedBytes` check.
 * That check runs AFTER the entire archive is already materialized in memory,
 * so the guard can never prevent the OOM it claims to: a 1 MB archive can
 * inflate to gigabytes before the cap is ever evaluated, and a single crafted
 * member is enough.
 *
 * This helper feeds the compressed bytes to fflate's streaming `Unzip` in
 * fixed-size slices and enforces a CUMULATIVE decompressed budget inside each
 * per-file `ondata` chunk callback — so it aborts mid-inflate the instant the
 * running total crosses the limit, never allocating materially more than the
 * budget. It counts ACTUAL decompressed bytes (not the archive's declared
 * sizes, which a bomb forges), so it is robust against lying headers.
 *
 * Lives in leaf `@appstrate/afps-shared` (re-exported by `@appstrate/core/zip`)
 * so the platform, sidecar, and the standalone `afps` runtime share ONE
 * bounded implementation.
 */

import { Unzip, UnzipInflate } from "fflate";

export type DecompressionLimitReason =
  "decompressed-budget-exceeded" | "file-too-large" | "too-many-files" | "corrupt-archive";

export class DecompressionLimitError extends Error {
  readonly reason: DecompressionLimitReason;
  constructor(reason: DecompressionLimitReason, detail?: string) {
    super(`ZIP decompression refused: ${reason}${detail ? ` (${detail})` : ""}`);
    this.name = "DecompressionLimitError";
    this.reason = reason;
  }
}

export interface BoundedUnzipLimits {
  /** Hard cap on the sum of all decompressed bytes. Aborts mid-inflate. */
  maxDecompressedBytes: number;
  /** Optional per-file decompressed cap. */
  maxFileBytes?: number;
  /** Optional cap on the number of entries. */
  maxFiles?: number;
}

const SLICE = 64 * 1024;

/**
 * Streaming, memory-bounded unzip. Returns a `name → bytes` record of the
 * archive's file entries (directory entries excluded). Throws
 * {@link DecompressionLimitError} the moment any budget is crossed — before the
 * offending bytes accumulate — or on a corrupt/unsupported archive.
 *
 * Path sanitization is intentionally NOT done here (callers apply their own
 * entry-name policy on the returned names); this primitive owns only the
 * resource-exhaustion boundary.
 */
export function unzipBounded(
  artifact: Uint8Array,
  limits: BoundedUnzipLimits,
): Record<string, Uint8Array> {
  const { maxDecompressedBytes, maxFileBytes, maxFiles } = limits;

  // Streaming `Unzip` scans for local-file-header signatures and silently
  // yields nothing on a buffer that isn't a ZIP — so guard the archive magic
  // up front. Every ZIP begins with "PK" (0x50 0x4b): a local file header
  // (PK\x03\x04) or, for an empty archive, the end-of-central-directory
  // (PK\x05\x06). Anything else is corrupt/non-ZIP and must fail loudly.
  if (artifact.length < 4 || artifact[0] !== 0x50 || artifact[1] !== 0x4b) {
    throw new DecompressionLimitError("corrupt-archive", "not a ZIP archive");
  }

  const out: Record<string, Uint8Array> = {};
  let total = 0;
  let fileCount = 0;
  let caught: unknown = null;

  const unzipper = new Unzip((file) => {
    fileCount += 1;
    if (maxFiles !== undefined && fileCount > maxFiles) {
      throw new DecompressionLimitError("too-many-files", `> ${maxFiles}`);
    }
    // Directory entries carry no data — skip; fflate still requires start().
    const isDir = file.name.endsWith("/");
    const chunks: Uint8Array[] = [];
    let fileSize = 0;
    file.ondata = (err, chunk, final) => {
      // Once a limit/corruption verdict is set, fflate may still invoke this
      // callback again within the same push (as it unwinds the inflate) — never
      // overwrite the first verdict; just re-throw it so the reason is stable.
      if (caught) throw caught;
      if (err) {
        caught = new DecompressionLimitError("corrupt-archive", err.message);
        throw caught;
      }
      fileSize += chunk.length;
      total += chunk.length;
      if (maxFileBytes !== undefined && fileSize > maxFileBytes) {
        caught = new DecompressionLimitError("file-too-large", file.name);
        throw caught;
      }
      if (total > maxDecompressedBytes) {
        caught = new DecompressionLimitError("decompressed-budget-exceeded");
        throw caught;
      }
      if (!isDir) chunks.push(chunk);
      if (final && !isDir) {
        out[file.name] = concatChunks(chunks, fileSize);
      }
    };
    file.start();
  });
  unzipper.register(UnzipInflate);

  try {
    for (let off = 0; off < artifact.length; off += SLICE) {
      const end = Math.min(off + SLICE, artifact.length);
      unzipper.push(artifact.subarray(off, end), end === artifact.length);
    }
  } catch (err) {
    if (err instanceof DecompressionLimitError) throw err;
    if (caught instanceof DecompressionLimitError) throw caught;
    throw new DecompressionLimitError(
      "corrupt-archive",
      err instanceof Error ? err.message : String(err),
    );
  }

  return out;
}

function concatChunks(chunks: Uint8Array[], size: number): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  const merged = new Uint8Array(size);
  let pos = 0;
  for (const c of chunks) {
    merged.set(c, pos);
    pos += c.length;
  }
  return merged;
}
