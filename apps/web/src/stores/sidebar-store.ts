// SPDX-License-Identifier: Apache-2.0

import { create } from "zustand";
import { persistedScalar } from "./persisted-scalar-store";

/**
 * Whether a shell sidebar is open, remembered across reloads.
 *
 * One store PER PRODUCT, each with its own key: Studio's sidebar and the chat's
 * hold different things, so folding one says nothing about the other — and a
 * shared flag would have the chat quietly re-fold Studio's navigation.
 */
function createSidebarStore(storageKey: string) {
  return create(persistedScalar(storageKey, (raw) => raw !== "false", "open", "setOpen"));
}

export const useSidebarStore = createSidebarStore("appstrate-sidebar");
export const useChatSidebarStore = createSidebarStore("appstrate-chat-sidebar");
