import { useEffect } from "react";

/**
 * Auto-select an item when the stored selection is missing or stale.
 * Used by org, profile, and application selectors to ensure a valid selection.
 */
export function useAutoSelect<T extends { id: string }>(
  items: T[] | undefined,
  currentId: string | null,
  setId: (id: string) => void,
  findDefault?: (items: T[]) => T | undefined,
): void {
  useEffect(() => {
    if (!items || items.length === 0) return;
    const storedExists = currentId && items.some((item) => item.id === currentId);
    if (!storedExists) {
      const target = findDefault?.(items) ?? items[0];
      if (target) setId(target.id);
    }
  }, [items, currentId, setId, findDefault]);
}
