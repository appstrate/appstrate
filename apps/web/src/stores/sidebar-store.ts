// SPDX-License-Identifier: Apache-2.0

import { create } from "zustand";

const STORAGE_KEY = "appstrate-sidebar";

interface SidebarState {
  open: boolean;
  setOpen: (open: boolean) => void;
  setOpenTransient: (open: boolean) => void;
}

const stored = localStorage.getItem(STORAGE_KEY);
const initialOpen = stored === null ? true : stored === "true";

export const useSidebarStore = create<SidebarState>()((set) => ({
  open: initialOpen,
  setOpen: (open) => {
    localStorage.setItem(STORAGE_KEY, String(open));
    set({ open });
  },
  setOpenTransient: (open) => set({ open }),
}));
