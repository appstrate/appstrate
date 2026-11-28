// SPDX-License-Identifier: Apache-2.0

import { create } from "zustand";
import { persistedJson } from "./local-storage";

/** A stored width, clamped; anything else (absent, unreadable, not positive) is null = the default. */
export function parseStoredWidth(value: unknown, clamp: (width: number) => number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? clamp(value) : null;
}

/**
 * A resizable panel's width, remembered per browser under `key` (null = the panel's default).
 * `setLive` follows the pointer during a drag without writing; `commit` stores the final width,
 * rounded, and null resets it. `dragging` lets the layout drop its transitions meanwhile.
 */
export function createPanelWidthStore(key: string, clamp: (width: number) => number) {
  const stored = persistedJson(key, (value) => parseStoredWidth(value, clamp));
  return create<{
    width: number | null;
    dragging: boolean;
    setLive: (width: number) => void;
    commit: (width: number | null) => void;
    setDragging: (dragging: boolean) => void;
  }>((set) => ({
    width: stored.read(),
    dragging: false,
    setLive: (width) => set({ width }),
    commit: (width) => {
      const next = width === null ? null : Math.round(width);
      stored.write(next);
      set({ width: next });
    },
    setDragging: (dragging) => set({ dragging }),
  }));
}
