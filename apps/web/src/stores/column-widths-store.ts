// SPDX-License-Identifier: Apache-2.0

import { useSyncExternalStore } from "react";
import { authStore } from "./auth-store";

/**
 * The widths a person gave a table's columns, remembered across reloads.
 *
 * Same call as `column-visibility-store.ts`: a convenience per person and per
 * table, never a location, and the table works without it. `localStorage` can
 * be absent (the test runner), blocked or full, so every access is guarded and
 * a failure only costs the person the width they chose.
 */

const PREFIX = "appstrate-column-widths-";

export type ColumnWidths = Readonly<Record<string, number>>;

const NONE: ColumnWidths = {};
const listeners = new Set<() => void>();
/** Cached per key so `getSnapshot` returns a stable reference between writes. */
const snapshots = new Map<string, ColumnWidths>();

/** One person's widths for one table: two accounts in one browser keep their own. */
function storageKey(table: string): string {
  return `${PREFIX}${authStore.getState().user?.id ?? "anonymous"}-${table}`;
}

function read(table: string): ColumnWidths {
  const key = storageKey(table);
  const cached = snapshots.get(key);
  if (cached) return cached;
  let parsed: Record<string, number> = {};
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    if (value && typeof value === "object") {
      for (const [id, width] of Object.entries(value)) {
        if (typeof width === "number" && Number.isFinite(width)) parsed[id] = width;
      }
    }
  } catch {
    parsed = {};
  }
  snapshots.set(key, parsed);
  return parsed;
}

function write(table: string, widths: ColumnWidths): void {
  snapshots.set(storageKey(table), widths);
  try {
    localStorage.setItem(storageKey(table), JSON.stringify(widths));
  } catch {
    // Kept for this session only.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export interface ColumnWidthsControl {
  widths: ColumnWidths;
  set: (id: string, width: number) => void;
}

/** `table` names the TABLE (its label): the same table keeps its widths wherever it is shown. */
export function useColumnWidths(table: string): ColumnWidthsControl {
  const widths = useSyncExternalStore(
    subscribe,
    () => read(table),
    () => NONE,
  );
  return {
    widths,
    set: (id, width) => write(table, { ...widths, [id]: Math.round(width) }),
  };
}
