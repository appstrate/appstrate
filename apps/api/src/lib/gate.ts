// SPDX-License-Identifier: Apache-2.0

/**
 * A bounded concurrency gate for CPU-heavy work on the API's own thread (a PDF
 * parse): a slot count, a bounded queue with a bounded wait, and a bounded hold.
 * `p-limit` queues without a bound and never gives a hung slot back, which is
 * the case this exists for.
 */

/** Why a gate refused or ended a piece of work. */
export class GateError extends Error {
  constructor(readonly reason: "queue_full" | "wait_timeout" | "hold_timeout") {
    super(`gate: ${reason}`);
    this.name = "GateError";
  }
}

interface GateOptions {
  /** Pieces of work in flight at once. */
  limit: number;
  /** Callers allowed to wait for a slot; the next one is refused at once (`queue_full`). */
  maxWaiting: number;
  /** How long a caller waits for a slot before it is refused (`wait_timeout`). */
  waitMs: number;
  /** How long a piece of work keeps its slot: past it the slot is freed and the work aborted (`hold_timeout`). */
  holdMs: number;
}

/**
 * At most `limit` pieces of work run at once, the others wait in a bounded queue for a bounded time,
 * and no piece of work keeps its slot for ever: a hung one is abandoned (its `signal` aborts, its
 * slot goes to the next caller). Without those bounds one hostile input holds a slot until restart
 * and `limit` of them refuse everyone else.
 */
export function createGate(
  options: GateOptions,
): <T>(work: (signal: AbortSignal) => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: Array<{ grant: () => void; timer: ReturnType<typeof setTimeout> }> = [];

  const release = () => {
    const next = waiting.shift();
    if (next) {
      clearTimeout(next.timer);
      next.grant();
    } else active -= 1;
  };

  return async (work) => {
    if (active >= options.limit) {
      if (waiting.length >= options.maxWaiting) throw new GateError("queue_full");
      // A waiter is handed the slot of the one that finished, so a caller arriving in between
      // cannot take it and push the count past the limit.
      await new Promise<void>((grant, reject) => {
        const entry = {
          grant,
          timer: setTimeout(() => {
            waiting.splice(waiting.indexOf(entry), 1);
            reject(new GateError("wait_timeout"));
          }, options.waitMs),
        };
        waiting.push(entry);
      });
    } else active += 1;

    const abandon = new AbortController();
    let held = true;
    const free = () => {
      if (!held) return;
      held = false;
      release();
    };
    const hold = setTimeout(() => {
      abandon.abort();
      free();
    }, options.holdMs);
    try {
      return await Promise.race([
        work(abandon.signal),
        new Promise<never>((_, reject) =>
          abandon.signal.addEventListener("abort", () => reject(new GateError("hold_timeout")), {
            once: true,
          }),
        ),
      ]);
    } finally {
      clearTimeout(hold);
      free();
    }
  };
}
