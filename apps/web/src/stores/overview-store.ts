// SPDX-License-Identifier: Apache-2.0

import { createStore } from "zustand/vanilla";
import { isPlainObject } from "@appstrate/core/safe-json";
import { LOCAL_STORAGE_KEYS, createLocalStore, jsonCodec } from "@appstrate/ui/local-storage";

/** Keyed like the remembered space (`rememberedSpaceKey`): per account and org. Only a stored `true` is a choice. */
const persisted = createLocalStore(
  LOCAL_STORAGE_KEYS.overview,
  jsonCodec((value): Record<string, true> =>
    isPlainObject(value)
      ? Object.fromEntries(
          Object.entries(value).flatMap(([key, on]) => (on === true ? [[key, true as const]] : [])),
        )
      : {},
  ),
);

interface OverviewState {
  /** Where the reader chose « Tous les espaces », per account and org. */
  chosen: Record<string, true>;
  set: (key: string, on: boolean) => void;
}

export const overviewStore = createStore<OverviewState>()((set) => ({
  chosen: persisted.read(),
  set: (key, on) => {
    // The persisted map, not this tab's copy: another tab may have written since.
    const chosen = { ...persisted.read() };
    if (on) chosen[key] = true;
    else delete chosen[key];
    persisted.write(chosen);
    set({ chosen });
  },
}));
