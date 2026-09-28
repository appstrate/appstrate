// SPDX-License-Identifier: Apache-2.0

import { useEffect } from "react";

/**
 * Auto-select an item when the stored selection is missing or stale.
 * Used by the org selector to ensure a valid selection.
 */
export function useAutoSelect<T extends { id: string }>(
  items: T[] | undefined,
  currentId: string | null,
  setId: (id: string) => void,
): void {
  useEffect(() => {
    if (!items || items.length === 0) return;
    const storedExists = currentId && items.some((item) => item.id === currentId);
    if (!storedExists) {
      setId(items[0]!.id);
    }
  }, [items, currentId, setId]);
}
