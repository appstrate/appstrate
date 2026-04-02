// SPDX-License-Identifier: Apache-2.0

import { create } from "zustand";

const STORAGE_KEY = "appstrate-sidebar";

interface SidebarState {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
}

const stored = localStorage.getItem(STORAGE_KEY);
const initialOpen = stored === null ? true : stored === "true";

export const useSidebarStore = create<SidebarState>()((set, get) => ({
  open: initialOpen,
  setOpen: (open) => {
    localStorage.setItem(STORAGE_KEY, String(open));
    set({ open });
  },
  toggle: () => {
    const next = !get().open;
    localStorage.setItem(STORAGE_KEY, String(next));
    set({ open: next });
  },
}));
