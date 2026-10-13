// SPDX-License-Identifier: Apache-2.0

/**
 * Resolve once `ms` have passed or `signal` aborts, whichever comes first.
 * Never rejects: the caller reads `signal.aborted` to tell the two apart. An
 * already-aborted signal resolves at once.
 */
export function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const settle = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", settle);
      resolve();
    };
    const timer = setTimeout(settle, ms);
    signal.addEventListener("abort", settle, { once: true });
  });
}
