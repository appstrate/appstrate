// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * Deterministic ZIP packager for mcp-server bundles.
 *
 * Plain `zipArtifact` (and fflate by default) embeds the current time
 * in each entry's mtime field, which breaks bit-for-bit
 * reproducibility. The bundler needs the property that "same input
 * tree + same level → same ZIP bytes" so an mcp-server version
 * published twice from the same source resolves to the same archive
 * hash (proposal §4.1.7).
 *
 * We fix this by pinning every entry's mtime to the DOS epoch (the
 * earliest legal ZIP timestamp). Compression level is exposed for
 * tests; production callers should keep the default (`6`).
 */

import { zipSync } from "fflate";

/** January 1, 1980 — the DOS-epoch baseline used by ZIP's date field. */
export const DOS_EPOCH_MS = Date.UTC(1980, 0, 2, 12, 0, 0);

export function packDeterministicZip(
  files: Record<string, Uint8Array>,
  level: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 = 6,
): Uint8Array {
  const entries: Record<string, [Uint8Array, { mtime: number; level: number }]> = {};
  // Sort keys to make sure the central directory order is stable
  // regardless of the input object's enumeration order.
  for (const key of Object.keys(files).sort()) {
    entries[key] = [files[key]!, { mtime: DOS_EPOCH_MS, level }];
  }
  return zipSync(
    entries as unknown as Parameters<typeof zipSync>[0],
    { level, mtime: DOS_EPOCH_MS } as Parameters<typeof zipSync>[1],
  );
}
