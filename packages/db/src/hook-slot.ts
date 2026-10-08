// SPDX-License-Identifier: Apache-2.0

/**
 * A process-global injection point `apps/api` fills at boot: what it plugs in
 * lives on the other side of a dependency `packages/db` cannot take.
 */
export function hookSlot<T>() {
  let current: T | null = null;
  return {
    get: (): T | null => current,
    set: (next: T): void => {
      current = next;
    },
    /** Test-only: install `next` (null = none) and return the previous value. */
    swapForTesting: (next: T | null): T | null => {
      const previous = current;
      current = next;
      return previous;
    },
  };
}
