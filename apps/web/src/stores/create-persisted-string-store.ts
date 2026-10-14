// SPDX-License-Identifier: Apache-2.0

import { createStore, type StoreApi } from "zustand/vanilla";
import { persistedValue } from "./local-storage";

interface PersistedStringState {
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
  const stored = persistedValue(storageKey, (raw) => raw);

  return createStore<PersistedStringState>()((set) => ({
    id: stored.read(),
    setId: (id) => {
      set({ id });
      stored.write(id || null);
    },
  }));
}
