// SPDX-License-Identifier: Apache-2.0

/**
 * Per-conversation "last seen" watermark, persisted in localStorage. A
 * conversation is unread when its server `updatedAt` is newer than the watermark
 * — i.e. its reply advanced while the user was not looking at it.
 *
 * Exposed as an external store (`useSyncExternalStore`) so the unread badge is
 * reactive without React state: writes happen in effects/handlers (syncing an
 * external system), never via setState, which keeps the React Compiler rules
 * happy and avoids render loops.
 */

const KEY = "appstrate.chat.seen";

function load(): Record<string, string> {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

let cache: Record<string, string> = load();
const listeners = new Set<() => void>();

export function subscribeSeen(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSeen(): Record<string, string> {
  return cache;
}

/** Record that the user has seen `id` up to `updatedAt`. No-op if unchanged. */
export function markSeen(id: string, updatedAt: string): void {
  if (cache[id] === updatedAt) return;
  cache = { ...cache, [id]: updatedAt };
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    // ignore quota / unavailable storage — the badge just won't persist.
  }
  for (const l of listeners) l();
}

/** A conversation is unread when its reply advanced past the seen watermark. */
export function isUnread(seen: Record<string, string>, id: string, updatedAt: string): boolean {
  return (seen[id] ?? "") < updatedAt;
}
