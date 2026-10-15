// SPDX-License-Identifier: Apache-2.0

import { create } from "zustand";
import { persistedScalar } from "./persisted-scalar-store";

/** Sidebar open state, persisted. One store PER PRODUCT so the chat never re-folds Studio's. */
function createSidebarStore(storageKey: string) {
  return create(persistedScalar(storageKey, (raw) => raw !== "false", "open", "setOpen"));
}

export const useSidebarStore = createSidebarStore("appstrate-sidebar");
export const useChatSidebarStore = createSidebarStore("appstrate-chat-sidebar");
