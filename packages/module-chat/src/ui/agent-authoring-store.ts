// SPDX-License-Identifier: Apache-2.0

/**
 * Agent authoring — the composer's switch for whether the assistant may create
 * agents (persistent, or composed on the fly for a one-off task).
 *
 * A PREFERENCE, not a permission: `agents:write` is checked server-side, and
 * off, the server drops it from the turn's token. Persisted per user, so a
 * choice made under one account never carries over to another in the same
 * browser; on unless that user's stored value says `"off"`. Unbound (no user
 * yet), it reads on and persists nothing.
 */

import { useSyncExternalStore } from "react";

const KEY_PREFIX = "appstrate.chat.agentAuthoring:";

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
export function bindAgentAuthoringUser(userId: string | null): void {
  const next = userId ? `${KEY_PREFIX}${userId}` : null;
  if (next === key) return;
  key = next;
  const value = read();
  if (value === cache) return;
  cache = value;
  notify();
}

export function subscribeAgentAuthoring(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getAgentAuthoringEnabled(): boolean {
  return cache;
}

export function setAgentAuthoringEnabled(enabled: boolean): void {
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

export function useAgentAuthoringEnabled(): boolean {
  return useSyncExternalStore(subscribeAgentAuthoring, getAgentAuthoringEnabled, () => true);
}
