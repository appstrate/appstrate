// SPDX-License-Identifier: Apache-2.0

import { useSyncExternalStore } from "react";
import { authStore } from "./auth-store";

/**
 * Which groups of a grouped table a person folded, remembered across reloads.
 *
 * Same call as `column-widths-store.ts`: a convenience per person and per
 * table, never a location, and the table works without it. `localStorage` can
 * be absent (the test runner), blocked or full, so every access is guarded and
 * a failure only costs the person their folds.
 */

const PREFIX = "appstrate-collapsed-groups-";

const NONE: readonly string[] = [];
const listeners = new Set<() => void>();
/** Cached per key so `getSnapshot` returns a stable reference between writes. */
const snapshots = new Map<string, readonly string[]>();

/** One person's folds for one table: two accounts in one browser keep their own. */
function storageKey(table: string): string {
  return `${PREFIX}${authStore.getState().user?.id ?? "anonymous"}-${table}`;
}

function read(table: string): readonly string[] {
  const key = storageKey(table);
  const cached = snapshots.get(key);
  if (cached) return cached;
  let parsed: string[] = [];
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    if (Array.isArray(value)) parsed = value.filter((v): v is string => typeof v === "string");
  } catch {
    parsed = [];
  }
  snapshots.set(key, parsed);
  return parsed;
}

function write(table: string, folded: readonly string[]): void {
  snapshots.set(storageKey(table), folded);
  try {
    localStorage.setItem(storageKey(table), JSON.stringify(folded));
  } catch {
    // Kept for this session only.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export interface CollapsedGroups {
  isCollapsed: (key: string) => boolean;
  toggle: (key: string) => void;
}

/** `table` names the TABLE (its label): the same table keeps its folds wherever it is shown. */
export function useCollapsedGroups(table: string): CollapsedGroups {
  const folded = useSyncExternalStore(
    subscribe,
    () => read(table),
    () => NONE,
  );
  return {
    isCollapsed: (key) => folded.includes(key),
    toggle: (key) =>
      write(table, folded.includes(key) ? folded.filter((k) => k !== key) : [...folded, key]),
  };
}
