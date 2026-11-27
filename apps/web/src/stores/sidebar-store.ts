// SPDX-License-Identifier: Apache-2.0

import { create } from "zustand";
import {
  LOCAL_STORAGE_KEYS,
  createLocalStore,
  scalarCodec,
  type LocalStorageEntry,
} from "@appstrate/ui/local-storage";
import { persistedScalar } from "./persisted-scalar-store";

/** Sidebar open state, persisted. One store PER PRODUCT so the chat never re-folds Studio's. */
function createSidebarStore(entry: LocalStorageEntry) {
  const stored = createLocalStore(
    entry,
    scalarCodec((raw) => raw !== "false"),
  );
  return create(persistedScalar(stored, "open", "setOpen"));
}

export const useSidebarStore = createSidebarStore(LOCAL_STORAGE_KEYS.sidebar);
export const useChatSidebarStore = createSidebarStore(LOCAL_STORAGE_KEYS.chatSidebar);
