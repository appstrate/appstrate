// SPDX-License-Identifier: Apache-2.0

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
