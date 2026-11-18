// SPDX-License-Identifier: Apache-2.0

/**
 * What one chat turn may import from connectors (`save_as_file` on an integration's `api_call`).
 *
 * A turn reads third-party content, which can carry an injected instruction to download everything
 * it can reach: each import is held in memory and then stored against the organization's quota, so
 * the turn is bounded in files and in bytes, on top of the per-call and per-file caps. The turn is
 * the one the chat's loopback bearer was minted for (its signed `turnId`); a turn runs inside one
 * process, so the counters are process-local, and a turn that ends leaves an entry the next sweep
 * drops.
 */

import { ApiError } from "@appstrate/core/api-errors";

/** Files one turn may import. */
export const TURN_IMPORT_MAX_FILES = 10;
/** Bytes one turn may import, in all. */
export const TURN_IMPORT_MAX_BYTES = 50 * 1024 * 1024;
/** How long a turn's counters are kept: past the turn deadline, which is 10 minutes. */
const ENTRY_TTL_MS = 30 * 60_000;
const MAX_ENTRIES = 2_000;

interface Entry {
  files: number;
  bytes: number;
  expiresAt: number;
}

const turns = new Map<string, Entry>();

function sweep(now: number): void {
  for (const [id, entry] of turns) {
    if (entry.expiresAt <= now) turns.delete(id);
  }
  // A flood of turns that never end is bounded by dropping the oldest first (Map order).
  while (turns.size > MAX_ENTRIES) turns.delete(turns.keys().next().value!);
}

/**
 * Charge one import of `bytes` to the turn, or refuse it: a 413 naming which limit it reached. The
 * returned function gives the charge back, for an import that then failed to store.
 */
export function chargeTurnImport(turnId: string, bytes: number, now = Date.now()): () => void {
  sweep(now);
  const entry = turns.get(turnId) ?? { files: 0, bytes: 0, expiresAt: now + ENTRY_TTL_MS };
  if (entry.files + 1 > TURN_IMPORT_MAX_FILES) {
    throw new ApiError({
      status: 413,
      code: "turn_import_limit",
      title: "Import limit reached",
      detail: `A turn may import at most ${TURN_IMPORT_MAX_FILES} files.`,
    });
  }
  if (entry.bytes + bytes > TURN_IMPORT_MAX_BYTES) {
    throw new ApiError({
      status: 413,
      code: "turn_import_limit",
      title: "Import limit reached",
      detail: `A turn may import at most ${TURN_IMPORT_MAX_BYTES / (1024 * 1024)} MiB in all.`,
    });
  }
  entry.files += 1;
  entry.bytes += bytes;
  turns.set(turnId, entry);
  return () => {
    entry.files -= 1;
    entry.bytes -= bytes;
  };
}

/** @internal Test-only. Forgets every turn. */
export function _resetTurnImportsForTesting(): void {
  turns.clear();
}
