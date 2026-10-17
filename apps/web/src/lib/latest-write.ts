// SPDX-License-Identifier: Apache-2.0

/**
 * Serialises the writes of settings that fire faster than the server answers
 * (arrow keys on a radio group): one write is in flight at a time, and while it
 * is, only the newest value of each `key` is remembered. When the write
 * settles, a remembered value is sent unless it is the one already sent — so
 * the stored value is always the last one picked, never an earlier one that
 * committed late. No timer: the first pick goes out at once.
 *
 * `run` is the write itself, closed over its target at call time, so a value
 * queued for one entity is never sent to another. A write that rejects is not
 * retried here (the mutation cache reports it) and is forgotten, so picking
 * the same value again sends it again.
 */
export function createLatestWriter(): (
  key: string,
  value: unknown,
  run: () => Promise<unknown>,
) => void {
  interface Write {
    value: unknown;
    run: () => Promise<unknown>;
  }
  const sent = new Map<string, unknown>();
  const queued = new Map<string, Write>();
  let inFlight = false;

  const drain = async (key: string, write: Write): Promise<void> => {
    inFlight = true;
    sent.set(key, write.value);
    try {
      await write.run();
    } catch {
      sent.delete(key);
    }
    inFlight = false;
    for (const [nextKey, next] of queued) {
      queued.delete(nextKey);
      if (sent.has(nextKey) && Object.is(sent.get(nextKey), next.value)) continue;
      void drain(nextKey, next);
      return;
    }
  };

  return (key, value, run) => {
    if (inFlight) {
      queued.set(key, { value, run });
      return;
    }
    void drain(key, { value, run });
  };
}
