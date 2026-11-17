// SPDX-License-Identifier: Apache-2.0

/**
 * A boolean composer preference persisted per user in `localStorage`, so a
 * choice made under one account never carries over to another in the same
 * browser. Only the departure from `defaultValue` is stored (`"on"` / `"off"`);
 * unbound (no user yet), the flag reads its default and persists nothing.
 */

import { useSyncExternalStore } from "react";

export interface UserFlag {
  /** Scope the flag to the signed-in user; the host calls it on sign-in and switch. */
  bind(userId: string | null): void;
  subscribe(listener: () => void): () => void;
  get(): boolean;
  set(value: boolean): void;
  use(): boolean;
}

export function createUserFlag(keyPrefix: string, defaultValue: boolean): UserFlag {
  let key: string | null = null;
  let cache = defaultValue;
  const listeners = new Set<() => void>();
  const stored = (value: boolean) => (value ? "on" : "off");

  const read = (): boolean => {
    if (key === null || typeof localStorage === "undefined") return defaultValue;
    try {
      const value = localStorage.getItem(key);
      return value === null ? defaultValue : value === "on";
    } catch {
      return defaultValue;
    }
  };
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const get = () => cache;

  return {
    bind(userId) {
      const next = userId ? `${keyPrefix}${userId}` : null;
      if (next === key) return;
      key = next;
      const value = read();
      if (value === cache) return;
      cache = value;
      notify();
    },
    subscribe,
    get,
    set(value) {
      if (cache === value) return;
      cache = value;
      if (key !== null) {
        try {
          if (value === defaultValue) localStorage.removeItem(key);
          else localStorage.setItem(key, stored(value));
        } catch {
          // ignore quota / unavailable storage — the choice just won't persist.
        }
      }
      notify();
    },
    use: () => useSyncExternalStore(subscribe, get, () => defaultValue),
  };
}
