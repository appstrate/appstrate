// SPDX-License-Identifier: Apache-2.0

/**
 * A composer switch persisted per user: on unless that user's stored value says
 * `"off"`, so a choice made under one account never carries over to another in
 * the same browser. Unbound (no user yet), it reads on and persists nothing.
 */

import { useSyncExternalStore } from "react";

export interface UserToggle {
  /** Scope the switch to the signed-in user; the host calls it on sign-in and switch. */
  bindUser(userId: string | null): void;
  subscribe(listener: () => void): () => void;
  get(): boolean;
  set(enabled: boolean): void;
  use(): boolean;
}

export function createUserToggle(keyPrefix: string): UserToggle {
  let key: string | null = null;
  let cache = true;
  const listeners = new Set<() => void>();

  const read = (): boolean => {
    if (key === null || typeof localStorage === "undefined") return true;
    try {
      return localStorage.getItem(key) !== "off";
    } catch {
      return true;
    }
  };
  const notify = (): void => {
    for (const listener of listeners) listener();
  };
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const get = (): boolean => cache;

  return {
    bindUser(userId) {
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
    set(enabled) {
      if (cache === enabled) return;
      cache = enabled;
      if (key !== null) {
        try {
          if (enabled) localStorage.removeItem(key);
          else localStorage.setItem(key, "off");
        } catch {
          // ignore quota / unavailable storage — the choice just won't persist.
        }
      }
      notify();
    },
    use: () => useSyncExternalStore(subscribe, get, () => true),
  };
}
