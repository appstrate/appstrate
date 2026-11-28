// SPDX-License-Identifier: Apache-2.0

import { create } from "zustand";
import { createPanelWidthStore } from "./panel-width-store";
import { persistedScalar } from "./persisted-scalar-store";

/** Sidebar open state, persisted. One store PER PRODUCT so the chat never re-folds Studio's. */
function createSidebarStore(storageKey: string) {
  return create(persistedScalar(storageKey, (raw) => raw !== "false", "open", "setOpen"));
}

export const useSidebarStore = createSidebarStore("appstrate-sidebar");
export const useChatSidebarStore = createSidebarStore("appstrate-chat-sidebar");

/**
 * The sidebar's desktop width bounds, in px, in both products. The default is shadcn's
 * `SIDEBAR_WIDTH` (16rem), so nothing moves for someone who never drags. `viewportPercent` caps it
 * on a narrow window, so the page keeps its room; never below the default, which never shrinks.
 */
export const SIDEBAR_WIDTH = {
  min: 224,
  default: 256,
  max: 480,
  viewportPercent: 30,
} as const;

/** The widest the sidebar may be in a window this wide: `min(max, max(default, 30% of it))`. */
export function sidebarMaxWidth(viewportWidth: number): number {
  const { default: base, max, viewportPercent } = SIDEBAR_WIDTH;
  return Math.min(max, Math.max(base, (viewportWidth * viewportPercent) / 100));
}

export function clampSidebarWidth(width: number, max: number = SIDEBAR_WIDTH.max): number {
  return Math.min(Math.max(width, SIDEBAR_WIDTH.min), max);
}

/**
 * The CSS width for a chosen one: the same cap as `sidebarMaxWidth`, in CSS, so a width stored
 * in a wider window follows the window's resizes without a listener.
 */
export function sidebarWidthCss(width: number | null): string {
  const { default: base, viewportPercent } = SIDEBAR_WIDTH;
  return `min(${width ?? base}px, max(${base}px, ${viewportPercent}vw))`;
}

/** The sidebar's width, one for both products. */
export const useSidebarWidthStore = createPanelWidthStore("appstrate-sidebar-width", (width) =>
  clampSidebarWidth(width),
);
