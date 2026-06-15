// SPDX-License-Identifier: Apache-2.0

/**
 * Pending OAuth model-provider pairings, persisted to localStorage so an
 * in-flight `npx @appstrate/connect-helper` connection survives the modal
 * being closed (tab switch, accidental dismiss) or even a full page reload.
 *
 * Only non-secret fields are stored: the pairing row id (`pair_...`), the
 * provider id, the TTL, and the org it was minted in. The bearer token —
 * the secret half of the command — is NEVER persisted; resuming the poll
 * needs only the id, and the helper already holds the token it needs to
 * complete the redeem.
 *
 * `<PendingPairingsWatcher>` reads this store to poll each pairing to
 * completion regardless of which modal (if any) is currently open. The
 * store is also synced across tabs via the `storage` event so a pairing
 * minted (or completed) in one tab is reflected in the others.
 */

import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";

export const STORAGE_KEY = "appstrate_pending_pairings";

export interface PendingPairing {
  /** Pairing row id (`pair_...`) — NOT the secret token. */
  id: string;
  providerId: string;
  /** ISO timestamp — when the pairing TTL elapses. */
  expiresAt: string;
  /** Org the pairing was minted in; the status route 404s cross-tenant. */
  orgId: string;
}

interface PairingState {
  pairings: PendingPairing[];
  add: (p: PendingPairing) => void;
  remove: (id: string) => void;
  /** Drop pairings whose TTL has elapsed (keeps the poller list bounded). */
  prune: () => void;
  /** Re-read the persisted list (used by the cross-tab `storage` sync). */
  hydrate: () => void;
}

function isPendingPairing(p: unknown): p is PendingPairing {
  if (!p || typeof p !== "object") return false;
  const c = p as Record<string, unknown>;
  return (
    typeof c.id === "string" &&
    typeof c.providerId === "string" &&
    typeof c.expiresAt === "string" &&
    typeof c.orgId === "string"
  );
}

/**
 * Lazily resolve the Web Storage backend. Feature-detected (not gated on
 * `window`) so it works in any host that exposes `localStorage`, and
 * returns `null` — never throws — when storage is absent or access is
 * denied (SSR, private-mode quota errors, tests without a DOM). Reading it
 * lazily also lets tests inject a fake `globalThis.localStorage`.
 */
function getStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Read + validate + TTL-filter the persisted list. Exported for tests. */
export function readPersistedPairings(): PendingPairing[] {
  const storage = getStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const now = Date.now();
    return parsed.filter(
      (p) => isPendingPairing(p) && new Date(p.expiresAt).getTime() > now,
    ) as PendingPairing[];
  } catch {
    return [];
  }
}

function persist(pairings: PendingPairing[]): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    if (pairings.length === 0) storage.removeItem(STORAGE_KEY);
    else storage.setItem(STORAGE_KEY, JSON.stringify(pairings));
  } catch {
    // Best-effort — a write failure (quota, private mode) just means the
    // pairing won't survive a reload; the in-memory poll still completes it.
  }
}

export const pairingStore = createStore<PairingState>()((set) => ({
  pairings: readPersistedPairings(),
  add: (p) =>
    set((s) => {
      const next = [...s.pairings.filter((x) => x.id !== p.id), p];
      persist(next);
      return { pairings: next };
    }),
  remove: (id) =>
    set((s) => {
      const next = s.pairings.filter((x) => x.id !== id);
      if (next.length === s.pairings.length) return s;
      persist(next);
      return { pairings: next };
    }),
  prune: () =>
    set((s) => {
      const now = Date.now();
      const next = s.pairings.filter((p) => new Date(p.expiresAt).getTime() > now);
      if (next.length === s.pairings.length) return s;
      persist(next);
      return { pairings: next };
    }),
  hydrate: () => set({ pairings: readPersistedPairings() }),
}));

// Cross-tab sync: when another tab mutates the persisted list, mirror it
// here so this tab's watcher picks up newly-minted pairings and drops ones
// another tab already completed (reducing duplicate success toasts).
if (typeof globalThis.addEventListener === "function") {
  globalThis.addEventListener("storage", (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) pairingStore.getState().hydrate();
  });
}

/** Reactive list for React components. */
export function usePendingPairings(): PendingPairing[] {
  return useStore(pairingStore, (s) => s.pairings);
}

/** Non-hook accessors for use from event handlers / effects. */
export function addPendingPairing(p: PendingPairing): void {
  pairingStore.getState().add(p);
}

export function removePendingPairing(id: string): void {
  pairingStore.getState().remove(id);
}
