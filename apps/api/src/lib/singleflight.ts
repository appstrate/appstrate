// SPDX-License-Identifier: Apache-2.0

/**
 * In-process request coalescing ("singleflight").
 *
 * Collapses concurrent callers asking for the same `key` onto one shared
 * in-flight promise. Purely per-process — this is NOT a distributed lock;
 * use it only where duplicate work is wasteful rather than incorrect.
 * (For cross-instance serialization of a side-effecting exchange, see
 * `dedupedRefresh`, which layers a Redis lock on top of the same idea.)
 */

/**
 * Run `fn` under `key`, sharing the in-flight promise with any concurrent
 * caller using the same key.
 *
 * The entry is removed once the promise settles, so a later call starts
 * fresh. Rejections propagate to every caller that joined the flight —
 * a joiner is asking for the same work, so it inherits the same outcome
 * rather than silently getting a stale success.
 */
export function singleflight<T>(
  inFlight: Map<string, Promise<unknown>>,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const joined = inFlight.get(key) as Promise<T> | undefined;
  if (joined) return joined;

  // Register the promise BEFORE any await point so a synchronous burst of
  // callers (the common case: N runs starting at once) all see the entry.
  const flight = fn().finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, flight);
  return flight;
}
