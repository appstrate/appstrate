// SPDX-License-Identifier: Apache-2.0

/** A leave confirmation applies to one destination and one form, never a later navigation. */
export function createNavigationApprovals<Key>() {
  let destination: string | null = null;
  const approved = new Set<Key>();
  const select = (target: string) => {
    if (destination !== target) {
      approved.clear();
      destination = target;
    }
  };
  return {
    approve(key: Key, target: string) {
      select(target);
      approved.add(key);
    },
    has(key: Key, target: string) {
      select(target);
      return approved.has(key);
    },
    clear() {
      destination = null;
      approved.clear();
    },
  };
}
