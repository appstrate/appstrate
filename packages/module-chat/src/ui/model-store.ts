// SPDX-License-Identifier: Apache-2.0

/**
 * Currently selected chat model (org preset id), persisted in localStorage.
 *
 * Exposed as an external store (`useSyncExternalStore`) rather than React
 * state so the transport's per-request header builder can read the CURRENT
 * selection through a stable function: `useChat` recreates its `Chat` instance
 * only when the conversation id changes, so a transport rebuilt over fresh
 * state is silently ignored and every send would keep the model captured at
 * mount.
 */

const KEY = "appstrate.chat.model";

let cache: string | null = typeof localStorage === "undefined" ? null : localStorage.getItem(KEY);
const listeners = new Set<() => void>();

export function subscribeModel(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSelectedModel(): string | null {
  return cache;
}

export function setSelectedModel(id: string | null): void {
  if (cache === id) return;
  cache = id;
  try {
    if (id === null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, id);
  } catch {
    // ignore quota / unavailable storage — the selection just won't persist.
  }
  for (const l of listeners) l();
}
