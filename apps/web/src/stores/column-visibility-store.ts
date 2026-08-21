// SPDX-License-Identifier: Apache-2.0

import { useSyncExternalStore } from "react";

/**
 * Which columns a user has hidden, per table, remembered across reloads.
 *
 * A preference and not a location, so it stays out of the URL: a link to a
 * filtered list should open on the reader's own columns rather than impose the
 * sender's — the same call as the cards/table view.
 *
 * Not zustand: there is one store per TABLE, created on demand from a key the
 * table passes, and a zustand store per key would either leak one hook factory
 * per table or be created during render. `useSyncExternalStore` over
 * localStorage is the whole thing, and it keeps two tables of the same kind on
 * one screen in step.
 */

const PREFIX = "appstrate-columns-";

const listeners = new Set<() => void>();
/** Cached per key so `getSnapshot` returns a stable reference between writes. */
const snapshots = new Map<string, string[]>();

function read(key: string): string[] {
  const cached = snapshots.get(key);
  if (cached) return cached;
  const raw = localStorage.getItem(PREFIX + key);
  let parsed: string[] = [];
  if (raw) {
    try {
      const value: unknown = JSON.parse(raw);
      if (Array.isArray(value)) parsed = value.filter((v): v is string => typeof v === "string");
    } catch {
      // A hand-edited or half-written value is not worth a crash: the user
      // loses a preference, not the screen.
    }
  }
  snapshots.set(key, parsed);
  return parsed;
}

function write(key: string, hidden: string[]): void {
  snapshots.set(key, hidden);
  localStorage.setItem(PREFIX + key, JSON.stringify(hidden));
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export interface ColumnVisibility {
  hidden: string[];
  toggle: (id: string) => void;
  showAll: () => void;
}

/** `key` names the TABLE, not the screen: the same table keeps its columns wherever it is shown. */
export function useColumnVisibility(key: string): ColumnVisibility {
  const hidden = useSyncExternalStore(
    subscribe,
    () => read(key),
    () => [] as string[],
  );

  return {
    hidden,
    toggle: (id) =>
      write(key, hidden.includes(id) ? hidden.filter((h) => h !== id) : [...hidden, id]),
    showAll: () => write(key, []),
  };
}
