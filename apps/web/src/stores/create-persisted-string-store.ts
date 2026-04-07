// SPDX-License-Identifier: Apache-2.0

import { createStore, type StoreApi } from "zustand/vanilla";

export interface PersistedStringState {
  id: string | null;
  setId: (id: string | null) => void;
}

/**
 * Factory for a Zustand vanilla store that persists a single string ID
 * to localStorage as a raw string (not JSON-wrapped).
 *
 * Each tab reads localStorage once on init and manages its own state
 * independently. No cross-tab sync — tabs can have different org/app
 * selections without interfering with each other.
 */
export function createPersistedStringStore(storageKey: string): StoreApi<PersistedStringState> {
  const initial = typeof window !== "undefined" ? localStorage.getItem(storageKey) : null;

  return createStore<PersistedStringState>()((set) => ({
    id: initial,
    setId: (id) => {
      set({ id });
      if (id) localStorage.setItem(storageKey, id);
      else localStorage.removeItem(storageKey);
    },
  }));
}
