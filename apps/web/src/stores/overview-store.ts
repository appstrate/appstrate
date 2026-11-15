// SPDX-License-Identifier: Apache-2.0

import { createStore } from "zustand/vanilla";
import { isPlainObject } from "@appstrate/core/safe-json";
import { persistedJson } from "./local-storage";

const STORAGE_KEY = "appstrate_overview";

/** Keyed like the remembered space (`rememberedSpaceKey`): per account and org. */
const persisted = persistedJson<Record<string, true>>(STORAGE_KEY, (value) =>
  isPlainObject(value) ? (value as Record<string, true>) : {},
);

interface OverviewState {
  /** Where the reader chose « Vue d'ensemble », per account and org. */
  chosen: Record<string, true>;
  set: (key: string, on: boolean) => void;
}

export const overviewStore = createStore<OverviewState>()((set) => ({
  chosen: persisted.read(),
  set: (key, on) => {
    // The persisted map, not this tab's copy: another tab may have written since.
    const chosen = persisted.read();
    if (on) chosen[key] = true;
    else delete chosen[key];
    persisted.write(chosen);
    set({ chosen });
  },
}));
