// SPDX-License-Identifier: Apache-2.0

// A failed warm-up is not a failed navigation. `main.tsx` asks `warmupPending()` before reloading
// on `vite:preloadError`: Vite dispatches that event BEFORE any userland `.catch()`, so the count
// is still held when the listener reads it. `lazy()` surfaces a real error on actual navigation.

let pending = 0;

export function warmupPending(): boolean {
  return pending > 0;
}

export function warmChunk(load: () => Promise<unknown>): void {
  pending++;
  void load()
    .catch(() => undefined)
    .finally(() => {
      pending--;
    });
}
