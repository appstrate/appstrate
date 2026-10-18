// SPDX-License-Identifier: Apache-2.0

/**
 * Package authoring — the composer's switch for whether the assistant may
 * create, import or edit packages of any type (agents, persistent or composed
 * on the fly for a one-off task, skills, integrations, local MCP servers).
 *
 * A PREFERENCE, not a permission: each type's `<type>:write` is checked
 * server-side, and off, the server drops them all from the turn's token. Persisted per user, so a
 * choice made under one account never carries over to another in the same
 * browser; on unless that user's stored value says `"off"`. Unbound (no user
 * yet), it reads on and persists nothing.
 */

import { useSyncExternalStore } from "react";

const KEY_PREFIX = "appstrate.chat.packageAuthoring:";

let key: string | null = null;
let cache = true;
const listeners = new Set<() => void>();

function read(): boolean {
  if (key === null || typeof localStorage === "undefined") return true;
  try {
    return localStorage.getItem(key) !== "off";
  } catch {
    return true;
  }
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** Scope the preference to the signed-in user; the host calls it on sign-in and switch. */
export function bindPackageAuthoringUser(userId: string | null): void {
  const next = userId ? `${KEY_PREFIX}${userId}` : null;
  if (next === key) return;
  key = next;
  const value = read();
  if (value === cache) return;
  cache = value;
  notify();
}

export function subscribePackageAuthoring(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getPackageAuthoringEnabled(): boolean {
  return cache;
}

export function setPackageAuthoringEnabled(enabled: boolean): void {
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
}

export function usePackageAuthoringEnabled(): boolean {
  return useSyncExternalStore(subscribePackageAuthoring, getPackageAuthoringEnabled, () => true);
}
