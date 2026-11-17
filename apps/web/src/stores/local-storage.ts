// SPDX-License-Identifier: Apache-2.0

import { useSyncExternalStore } from "react";

/**
 * Per-browser preferences. `localStorage` can be absent (tests), blocked or full,
 * so every access is guarded: a failure only costs the preference.
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

/** Stored JSON narrowed by `parse`; `fallback` answers an absent, unparseable or rejected value. */
function parseStored<T>(raw: string | null, parse: (value: unknown) => T, fallback: () => T): T {
  if (raw === null) return fallback();
  try {
    return parse(JSON.parse(raw));
  } catch {
    return fallback();
  }
}

/** One stored scalar under `key`; writing `null` removes it. */
export function persistedValue<T extends string | boolean | null>(
  key: string,
  parse: (raw: string | null) => T,
) {
  return {
    read: (): T => parse(readItem(key)),
    write: (value: T): void => writeItem(key, value === null ? null : String(value)),
  };
}

/** One stored JSON value under `key`; absent or unparseable JSON reaches `parse` as `null`. Writing `null` removes it. */
export function persistedJson<T>(key: string, parse: (value: unknown) => T) {
  return {
    read: (): T => parseStored(readItem(key), parse, () => parse(null)),
    write: (value: T | null): void => writeItem(key, value === null ? null : JSON.stringify(value)),
  };
}

/**
 * One JSON value per key under `prefix`, shared across components naming the
 * same key. Not zustand: keys arrive on demand, a store per key would be created
 * during render. An unparseable value reads as `empty`.
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
    const value = parseStored(readItem(prefix + key), parse, () => empty);
    snapshots.set(key, value);
    return value;
  };

  const write = (key: string, value: T): void => {
    snapshots.set(key, value);
    writeItem(prefix + key, JSON.stringify(value));
    for (const listener of listeners) listener();
  };

  const useValue = (key: string): [T, (value: T) => void] => {
    const snapshot = () => read(key);
    const value = useSyncExternalStore(subscribe, snapshot, snapshot);
    return [value, (next) => write(key, next)];
  };

  return { read, write, useValue };
}
