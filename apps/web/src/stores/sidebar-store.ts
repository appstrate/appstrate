// SPDX-License-Identifier: Apache-2.0

import { create } from "zustand";
import { persistedScalar } from "./persisted-scalar-store";
import { persistedValue } from "./local-storage";

/** Sidebar open state, persisted. One store PER PRODUCT so the chat never re-folds Studio's. */
function createSidebarStore(storageKey: string) {
  return create(persistedScalar(storageKey, (raw) => raw !== "false", "open", "setOpen"));
}

export const useSidebarStore = createSidebarStore("appstrate-sidebar");
export const useChatSidebarStore = createSidebarStore("appstrate-chat-sidebar");

/**
 * The chat's sidebar width on desktop, in px: its conversation titles are worth widening. The
 * default is the phone drawer's 18rem, so « Nouvelle conversation » and its magnifier share one line
 * as they do there.
 */
export const CHAT_SIDEBAR_WIDTH = { min: 224, default: 288, max: 480 } as const;

export function clampChatSidebarWidth(width: number): number {
  return Math.min(Math.max(width, CHAT_SIDEBAR_WIDTH.min), CHAT_SIDEBAR_WIDTH.max);
}

/** A stored width, or null (absent, unreadable or not a positive number: the default applies). */
export function parseChatSidebarWidth(raw: string | null): number | null {
  const width = raw === null ? NaN : Number(raw);
  return Number.isFinite(width) && width > 0 ? clampChatSidebarWidth(width) : null;
}

const chatSidebarWidth = persistedValue("appstrate-chat-sidebar-width", (raw) => raw);

/**
 * The chat sidebar's width, remembered per browser (null = the default). `setLive` follows the
 * pointer during a drag without writing; `commit` stores the final width, null resets it.
 */
export const useChatSidebarWidthStore = create<{
  width: number | null;
  dragging: boolean;
  setLive: (width: number) => void;
  commit: (width: number | null) => void;
  setDragging: (dragging: boolean) => void;
}>((set) => ({
  width: parseChatSidebarWidth(chatSidebarWidth.read()),
  dragging: false,
  setLive: (width) => set({ width }),
  commit: (width) => {
    chatSidebarWidth.write(width === null ? null : String(Math.round(width)));
    set({ width });
  },
  setDragging: (dragging) => set({ dragging }),
}));
