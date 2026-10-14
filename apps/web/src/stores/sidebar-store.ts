// SPDX-License-Identifier: Apache-2.0

import { create } from "zustand";
import { persistedValue } from "./local-storage";

interface SidebarState {
  open: boolean;
  setOpen: (open: boolean) => void;
}

/**
 * Whether a shell sidebar is open, remembered across reloads.
 *
 * One store PER PRODUCT, each with its own key: Studio's sidebar and the chat's
 * hold different things, so folding one says nothing about the other — and a
 * shared flag would have the chat quietly re-fold Studio's navigation.
 */
function createSidebarStore(storageKey: string) {
  const stored = persistedValue(storageKey, (raw) => raw !== "false");
  return create<SidebarState>()((set) => ({
    open: stored.read(),
    setOpen: (open) => {
      stored.write(open);
      set({ open });
    },
  }));
}

export const useSidebarStore = createSidebarStore("appstrate-sidebar");
export const useChatSidebarStore = createSidebarStore("appstrate-chat-sidebar");
