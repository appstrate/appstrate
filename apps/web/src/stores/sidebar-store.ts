// SPDX-License-Identifier: Apache-2.0

import { create } from "zustand";

interface SidebarState {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
}

/**
 * Whether a shell sidebar is open, remembered across reloads.
 *
 * One store PER PRODUCT, each with its own key: Studio's sidebar and the chat's
 * hold different things, so folding one says nothing about the other — and a
 * shared flag would have the chat quietly re-fold Studio's navigation, which is
 * exactly the coupling the chat's `setOpenTransient` hack was working around.
 */
function createSidebarStore(storageKey: string) {
  const stored = localStorage.getItem(storageKey);
  return create<SidebarState>()((set, get) => ({
    open: stored === null ? true : stored === "true",
    setOpen: (open) => {
      localStorage.setItem(storageKey, String(open));
      set({ open });
    },
    toggle: () => {
      const next = !get().open;
      localStorage.setItem(storageKey, String(next));
      set({ open: next });
    },
  }));
}

export const useSidebarStore = createSidebarStore("appstrate-sidebar");
export const useChatSidebarStore = createSidebarStore("appstrate-chat-sidebar");
