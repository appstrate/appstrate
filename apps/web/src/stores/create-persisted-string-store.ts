import { createStore, type StoreApi } from "zustand/vanilla";

export interface PersistedStringState {
  id: string | null;
  setId: (id: string | null) => void;
}

/**
 * Factory for a Zustand vanilla store that persists a single string ID
 * to localStorage as a raw string (not JSON-wrapped), with cross-tab sync.
 */
export function createPersistedStringStore(storageKey: string): StoreApi<PersistedStringState> {
  const initial = typeof window !== "undefined" ? localStorage.getItem(storageKey) : null;

  const store = createStore<PersistedStringState>()((set) => ({
    id: initial,
    setId: (id) => {
      set({ id });
      if (id) localStorage.setItem(storageKey, id);
      else localStorage.removeItem(storageKey);
    },
  }));

  if (typeof window !== "undefined") {
    window.addEventListener("storage", (e) => {
      if (e.key === storageKey) store.setState({ id: e.newValue });
    });
  }

  return store;
}
