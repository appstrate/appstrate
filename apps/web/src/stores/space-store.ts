// SPDX-License-Identifier: Apache-2.0

import { createStore } from "zustand/vanilla";

const STORAGE_KEY = "appstrate_current_space";

interface SpaceState {
  /**
   * The space every request is scoped to. Starts null: the persisted id may
   * name a space the caller can no longer enter (removed, deleted, a persona
   * without it), so only `useSpaceResolver` promotes it, once proven enterable.
   */
  id: string | null;
  /** The last space chosen, persisted across reloads — a candidate, never a scope. */
  remembered: string | null;
  setId: (id: string | null) => void;
}

export const spaceStore = createStore<SpaceState>()((set) => ({
  id: null,
  remembered: typeof window !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null,
  setId: (id) => {
    set({ id, remembered: id });
    if (id) localStorage.setItem(STORAGE_KEY, id);
    else localStorage.removeItem(STORAGE_KEY);
  },
}));

/** Non-hook accessor for use outside React (e.g. api.ts headers) */
export function getCurrentSpaceId(): string | null {
  return spaceStore.getState().id;
}
