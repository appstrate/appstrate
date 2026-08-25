// SPDX-License-Identifier: Apache-2.0

/**
 * `Promise.all`-shaped map with a bounded worker pool, for side-effecting
 * work whose results the caller does not collect.
 *
 * Both current callers fan out DB round-trips at boot and cap themselves well
 * under the postgres.js pool (`max: 20`) so the rest of the process is not
 * queued behind them — see `SYNC_CONCURRENCY` in `services/system-packages.ts`
 * and `ORPHAN_CLEANUP_CONCURRENCY` in `lib/boot.ts`.
 *
 * Not to be confused with `mapWithConcurrency` in `services/input-parser.ts`:
 * that one COLLECTS results into an index-preserving array and aborts the
 * remaining workers on the first rejection. This one returns nothing.
 */
export async function mapBounded<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const item = items[cursor++]!;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
