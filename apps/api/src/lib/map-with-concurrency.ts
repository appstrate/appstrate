// SPDX-License-Identifier: Apache-2.0

/**
 * The bounded worker pool. One implementation, one set of semantics.
 *
 * There used to be two: this one (then living in `services/input-parser.ts`)
 * and a `mapBounded` in `lib/map-bounded.ts` whose own header acknowledged the
 * pair without reconciling it. They differed on the only thing that matters
 * when a callback rejects — `mapBounded` kept pulling the remaining items while
 * the rejection propagated, so a boot-time fan-out went on doing work nobody
 * was going to wait for. This one is the strict superset (it also collects
 * results, index-preserving), so the pair collapsed onto it.
 *
 * Callers that discard the result array simply ignore the return value; the
 * array costs one allocation of `items.length` slots.
 */

/**
 * Map over `items` running at most `limit` callbacks concurrently, preserving
 * input order in the result. On the first rejection, in-flight callbacks are
 * allowed to settle but no new ones start, and the rejection propagates — the
 * caller rolls back any partial work.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let aborted = false;
  async function worker(): Promise<void> {
    while (!aborted) {
      const i = nextIndex++;
      if (i >= items.length) break;
      try {
        results[i] = await fn(items[i]!, i);
      } catch (err) {
        aborted = true;
        throw err;
      }
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
