// SPDX-License-Identifier: Apache-2.0

import { create } from "zustand";
import { persistedJson } from "./local-storage";
import { persistedScalar } from "./persisted-scalar-store";

/** Sidebar open state, persisted. One store PER PRODUCT so the chat never re-folds Studio's. */
function createSidebarStore(storageKey: string) {
  return create(persistedScalar(storageKey, (raw) => raw !== "false", "open", "setOpen"));
}

export const useSidebarStore = createSidebarStore("appstrate-sidebar");
export const useChatSidebarStore = createSidebarStore("appstrate-chat-sidebar");

/**
 * The chat sidebar's desktop width bounds, in px. The default is shadcn's `SIDEBAR_WIDTH` (16rem),
 * so nothing moves for someone who never drags.
 */
export const CHAT_SIDEBAR_WIDTH = { min: 224, default: 256, max: 480 } as const;

export function clampChatSidebarWidth(width: number): number {
  return Math.min(Math.max(width, CHAT_SIDEBAR_WIDTH.min), CHAT_SIDEBAR_WIDTH.max);
}

/** A stored width, clamped; anything else (absent, unreadable, not positive) is null = the default. */
export function parseChatSidebarWidth(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? clampChatSidebarWidth(value)
    : null;
}

const storedWidth = persistedJson("appstrate-chat-sidebar-width", parseChatSidebarWidth);

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
  width: storedWidth.read(),
  dragging: false,
  setLive: (width) => set({ width }),
  commit: (width) => {
    const next = width === null ? null : Math.round(width);
    storedWidth.write(next);
    set({ width: next });
  },
  setDragging: (dragging) => set({ dragging }),
}));
