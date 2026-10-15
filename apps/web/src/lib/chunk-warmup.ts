// SPDX-License-Identifier: Apache-2.0

/**
 * Downloading a lazy chunk nobody has asked for yet.
 *
 * A warm-up that fails is not a failed navigation: the user is not looking at
 * a broken screen, so there is nothing to recover. `main.tsx` reloads the tab
 * on `vite:preloadError` to pick up a redeploy's chunk graph, and asks
 * `warmupPending()` first. The `.catch()` alone does not keep that event from
 * firing: `import()` compiles to Vite's `__vitePreload`, which dispatches it
 * from its own rejection handler BEFORE any userland one runs — so the count is
 * still held when the listener reads it. `lazy()` re-imports and surfaces a
 * real error if the user ever navigates there.
 */

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
