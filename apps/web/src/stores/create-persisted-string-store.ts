import { createStore, type StoreApi } from "zustand/vanilla";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

export interface PersistedStringState {
  id: string | null;
  setId: (id: string | null) => void;
}

/**
 * Factory for a Zustand vanilla store that persists a single string ID
 * to localStorage as a raw string (not JSON-wrapped), with cross-tab sync.
 */
export function createPersistedStringStore(storageKey: string): StoreApi<PersistedStringState> {
  const storage: PersistStorage<PersistedStringState> = {
    getItem: (key): StorageValue<PersistedStringState> | null => {
      const value = localStorage.getItem(key);
      if (value === null) return null;
      return { state: { id: value } as PersistedStringState, version: 0 };
    },
    setItem: (key, stored) => {
      const v = stored?.state?.id;
      if (v) localStorage.setItem(key, v);
      else localStorage.removeItem(key);
    },
    removeItem: (key) => localStorage.removeItem(key),
  };

  const store = createStore<PersistedStringState>()(
    persist((set) => ({ id: null, setId: (id) => set({ id }) }), { name: storageKey, storage }),
  );

  if (typeof window !== "undefined") {
    window.addEventListener("storage", (e) => {
      if (e.key === storageKey) store.setState({ id: e.newValue });
    });
  }

  return store;
}
