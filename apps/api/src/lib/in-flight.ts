// SPDX-License-Identifier: Apache-2.0

/**
 * A registry of fire-and-forget promises that graceful shutdown must still
 * await: `track` registers one until it settles, `drain` awaits every tracked
 * promise (including ones registered while draining) up to a cap.
 */
export interface InFlightRegistry {
  /** Register `promise` until it settles; returns it unchanged. */
  track<T>(promise: Promise<T>): Promise<T>;
  size(): number;
  /** `pending` = promises awaited; `drained` = false when the cap fired first. */
  drain(timeoutMs: number): Promise<{ pending: number; drained: boolean }>;
}

export function createInFlightRegistry(): InFlightRegistry {
  const inFlight = new Set<Promise<unknown>>();
  return {
    track(promise) {
      inFlight.add(promise);
      // Both branches: a rejected `finally` chain would be an unhandled rejection.
      const untrack = () => void inFlight.delete(promise);
      promise.then(untrack, untrack);
      return promise;
    },
    size: () => inFlight.size,
    async drain(timeoutMs) {
      let awaited = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
        timer.unref?.();
      });
      try {
        while (inFlight.size > 0) {
          const pending = [...inFlight];
          awaited += pending.length;
          const outcome = await Promise.race([
            Promise.allSettled(pending).then(() => "settled" as const),
            timeout,
          ]);
          if (outcome === "timeout") return { pending: awaited, drained: false };
        }
        return { pending: awaited, drained: true };
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}
