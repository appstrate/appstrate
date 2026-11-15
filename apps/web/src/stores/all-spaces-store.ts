// SPDX-License-Identifier: Apache-2.0

import { createStore } from "zustand/vanilla";
import { isPlainObject } from "@appstrate/core/safe-json";
import { persistedJson } from "./local-storage";

const STORAGE_KEY = "appstrate_all_spaces";

/** Keyed like the remembered space (`rememberedSpaceKey`): per account and org. */
const persisted = persistedJson<Record<string, true>>(STORAGE_KEY, (value) =>
  isPlainObject(value) ? (value as Record<string, true>) : {},
);

interface AllSpacesState {
  /** The lists spanning spaces open on every offered space, per account and org. */
  remembered: Record<string, true>;
  set: (key: string, on: boolean) => void;
}

export const allSpacesStore = createStore<AllSpacesState>()((set) => ({
  remembered: persisted.read(),
  set: (key, on) => {
    // The persisted map, not this tab's copy: another tab may have written since.
    const remembered = persisted.read();
    if (on) remembered[key] = true;
    else delete remembered[key];
    persisted.write(remembered);
    set({ remembered });
  },
}));
