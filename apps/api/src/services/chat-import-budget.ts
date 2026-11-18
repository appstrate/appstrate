// SPDX-License-Identifier: Apache-2.0

/**
 * What one chat turn may import from connectors (`save_as_file` on an integration's `api_call`).
 *
 * A turn reads third-party content, which can carry an injected instruction to download everything
 * it can reach: each import is held in memory and then stored against the organization's quota, so
 * the turn is bounded in files and in bytes, on top of the per-call and per-file caps. The turn is
 * the one the chat's loopback bearer was minted for (its signed `turnId`).
 *
 * Counted by the platform's rate limiter (`getRateLimiterFactory`: Redis-backed, in memory on a
 * single instance), as two budgets keyed by the turn, so the counters expire with the window and
 * agree across replicas.
 */

import type { RateLimiterAbstract } from "rate-limiter-flexible";
import { ApiError } from "@appstrate/core/api-errors";
import { getRateLimiterFactory } from "../infra/index.ts";

/** Files one turn may import. */
export const TURN_IMPORT_MAX_FILES = 10;
/** Bytes one turn may import, in all. */
export const TURN_IMPORT_MAX_BYTES = 50 * 1024 * 1024;
/** How long a turn's counters are kept, in seconds: past the turn deadline, which is 10 minutes. */
const WINDOW_SECONDS = 30 * 60;

let limiters: Promise<{ files: RateLimiterAbstract; bytes: RateLimiterAbstract }> | null = null;

function getLimiters() {
  limiters ??= getRateLimiterFactory().then((factory) => ({
    files: factory.create(TURN_IMPORT_MAX_FILES, WINDOW_SECONDS, "rl:chat-import-files:"),
    bytes: factory.create(TURN_IMPORT_MAX_BYTES, WINDOW_SECONDS, "rl:chat-import-bytes:"),
  }));
  return limiters;
}

function limitReached(detail: string): ApiError {
  return new ApiError({
    status: 413,
    code: "turn_import_limit",
    title: "Import limit reached",
    detail,
  });
}

/**
 * Take `points` from one budget, or give them back and refuse: a refused consume still counts in
 * the limiter, and an import it refuses must leave the room it found.
 */
async function take(
  limiter: RateLimiterAbstract,
  turnId: string,
  points: number,
  refusal: string,
): Promise<void> {
  try {
    await limiter.consume(turnId, points);
  } catch {
    await limiter.reward(turnId, points);
    throw limitReached(refusal);
  }
}

/**
 * Charge one import of `bytes` to the turn, or refuse it: a 413 naming which limit it reached. The
 * returned function gives the charge back, for an import that then failed to store.
 */
export async function chargeTurnImport(
  turnId: string,
  bytes: number,
): Promise<() => Promise<void>> {
  const { files, bytes: byteBudget } = await getLimiters();
  await take(files, turnId, 1, `A turn may import at most ${TURN_IMPORT_MAX_FILES} files.`);
  try {
    await take(
      byteBudget,
      turnId,
      bytes,
      `A turn may import at most ${TURN_IMPORT_MAX_BYTES / (1024 * 1024)} MiB in all.`,
    );
  } catch (error) {
    await files.reward(turnId, 1);
    throw error;
  }
  return async () => {
    await Promise.all([files.reward(turnId, 1), byteBudget.reward(turnId, bytes)]);
  };
}

/** @internal Test-only. Fresh limiters, so no turn carries counts from another test. */
export function _resetTurnImportsForTesting(): void {
  limiters = null;
}
