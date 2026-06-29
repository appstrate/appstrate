// SPDX-License-Identifier: Apache-2.0

/**
 * In-flight chat turn registry. A "turn" promise resolves once the assistant
 * message has been persisted (the server-side, connection-independent task in
 * finalize-stream.ts). On graceful shutdown the module awaits these so a deploy
 * or restart does not drop a reply that was mid-generation — bounded by a
 * timeout so a wedged turn cannot block shutdown indefinitely.
 */

const inflight = new Set<Promise<unknown>>();

export function trackTurn(promise: Promise<unknown>): void {
  inflight.add(promise);
  void promise.finally(() => inflight.delete(promise));
}

export function inflightCount(): number {
  return inflight.size;
}

/**
 * Await all in-flight turns, capped at `timeoutMs`. Returns the number of turns
 * that were pending when the drain started.
 */
export async function drainTurns(timeoutMs = 25_000): Promise<number> {
  const pending = [...inflight];
  if (pending.length === 0) return 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
  await Promise.race([Promise.allSettled(pending), timeout]);
  if (timer) clearTimeout(timer);
  return pending.length;
}
