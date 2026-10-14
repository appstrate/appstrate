// SPDX-License-Identifier: Apache-2.0

import { useSyncExternalStore } from "react";

/**
 * Preferences kept per browser: a convenience, never a location, and the
 * screen works without them. `localStorage` can be absent (the test runner),
 * blocked (sandboxed frame, disabled site data) or full, so every access is
 * guarded and a failure only costs the preference — never a click handler or
 * the module load that reads it.
 */
function readItem(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** `null` removes the key. */
function writeItem(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Kept for this session only.
  }
}

/**
 * One stored scalar under `key`; `parse` turns whatever is there (or nothing)
 * into a value. Writing `null` removes it.
 */
export function persistedValue<T extends string | boolean | null>(
  key: string,
  parse: (raw: string | null) => T,
) {
  return {
    read: (): T => parse(readItem(key)),
    write: (value: T): void => writeItem(key, value === null ? null : String(value)),
  };
}

/**
 * One JSON value per key under `prefix` — a table's hidden columns, its column
 * widths — shared by every component naming the same key and kept in step
 * across them.
 *
 * Not zustand: keys arrive on demand from the component, and a store per key
 * would be created during render. A value that does not parse (hand-edited,
 * half-written) reads as `empty`.
 */
export function createKeyedLocalStore<T>(prefix: string, parse: (value: unknown) => T, empty: T) {
  const listeners = new Set<() => void>();
  /** Cached per key so `getSnapshot` returns a stable reference between writes. */
  const snapshots = new Map<string, T>();

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const read = (key: string): T => {
    if (snapshots.has(key)) return snapshots.get(key) as T;
    let value = empty;
    const raw = readItem(prefix + key);
    if (raw !== null) {
      try {
        value = parse(JSON.parse(raw));
      } catch {
        value = empty;
      }
    }
    snapshots.set(key, value);
    return value;
  };

  const write = (key: string, value: T): void => {
    snapshots.set(key, value);
    writeItem(prefix + key, JSON.stringify(value));
    for (const listener of listeners) listener();
  };

  const useValue = (key: string): [T, (value: T) => void] => {
    // The SPA is never server-rendered: the static render the tests use reads
    // the same storage as the browser.
    const snapshot = () => read(key);
    const value = useSyncExternalStore(subscribe, snapshot, snapshot);
    return [value, (next) => write(key, next)];
  };

  return { read, write, useValue };
}
