// SPDX-License-Identifier: Apache-2.0

/**
 * Pending OAuth model-provider pairings, persisted to localStorage so an
 * in-flight `npx @appstrate/connect-helper` connection survives the modal
 * being closed (tab switch, accidental dismiss) or even a full page reload.
 *
 * `<PendingPairingsWatcher>` reads this store to poll each pairing to
 * completion regardless of which modal (if any) is currently open. The
 * store is also synced across tabs via the `storage` event so a pairing
 * minted (or completed) in one tab is reflected in the others.
 */

import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import type { PairingTarget } from "../lib/oauth-pairing";
import { persistedJson } from "./local-storage";

export const STORAGE_KEY = "appstrate_pending_pairings";

// Bounds the entries no poll ends; it does not complete a pairing. Sized past the server row's
// lifetime (1 h grace + 15 min sweep), so a polled entry reaches its outcome first.
export const UNPOLLED_RETENTION_MS = 2 * 60 * 60_000;

export interface PendingPairing {
  /** Pairing row id (`pair_...`) — NOT the secret token. */
  id: string;
  providerId: string;
  target: PairingTarget;
  /** ISO timestamp — when the pairing TTL elapses. */
  expiresAt: string;
  /** Org the pairing was minted in; the status route 404s cross-tenant. */
  orgId: string;
}

interface PairingState {
  pairings: PendingPairing[];
  add: (p: PendingPairing) => void;
  remove: (id: string) => void;
  prune: () => void;
  clear: () => void;
  /** Re-read the persisted list (used by the cross-tab `storage` sync). */
  hydrate: () => void;
}

function isPairingTarget(t: unknown): t is PairingTarget {
  if (!t || typeof t !== "object") return false;
  const c = t as Record<string, unknown>;
  return c.credentialId === undefined
    ? c.ownerType === "org" || c.ownerType === "user"
    : typeof c.credentialId === "string" && c.ownerType === undefined;
}

function isPendingPairing(p: unknown): p is PendingPairing {
  if (!p || typeof p !== "object") return false;
  const c = p as Record<string, unknown>;
  return (
    typeof c.id === "string" &&
    typeof c.providerId === "string" &&
    isPairingTarget(c.target) &&
    typeof c.expiresAt === "string" &&
    typeof c.orgId === "string"
  );
}

function isRetained(p: PendingPairing, now: number): boolean {
  return new Date(p.expiresAt).getTime() + UNPOLLED_RETENTION_MS > now;
}

// A write failure (quota, private mode) just means the pairing won't survive a reload; the
// in-memory poll still completes it.
const persisted = persistedJson(STORAGE_KEY, (value): PendingPairing[] => {
  const now = Date.now();
  return Array.isArray(value)
    ? value.filter((p): p is PendingPairing => isPendingPairing(p) && isRetained(p, now))
    : [];
});

/** Read + validate + retention-filter the persisted list. Exported for tests. */
export const readPersistedPairings = persisted.read;

function persist(pairings: PendingPairing[]): void {
  persisted.write(pairings.length === 0 ? null : pairings);
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
      const next = s.pairings.filter((p) => isRetained(p, now));
      if (next.length === s.pairings.length) return s;
      persist(next);
      return { pairings: next };
    }),
  clear: () => {
    persist([]);
    set({ pairings: [] });
  },
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

// Each command carries its pairing's bearer token: memory only, never in storage (the poll
// needs only the id, and the helper holds the token).
const commands = new Map<string, string>();

pairingStore.subscribe(({ pairings }) => {
  for (const id of commands.keys()) {
    if (!pairings.some((p) => p.id === id)) commands.delete(id);
  }
});

const shown = new Set<string>();

/** Non-hook accessors for use from event handlers / effects. */
export function addPendingPairing(p: PendingPairing, command: string): void {
  commands.set(p.id, command);
  pairingStore.getState().add(p);
}

export function removePendingPairing(id: string): void {
  pairingStore.getState().remove(id);
}

export function clearPendingPairings(): void {
  pairingStore.getState().clear();
}

// No margin is asked of the remaining TTL: the pairing shown may be the one whose command the
// user is already running.
export function resumablePairing(
  match: Pick<PendingPairing, "orgId" | "providerId" | "target">,
): { id: string; command: string } | null {
  const now = Date.now();
  let resumable: { id: string; command: string } | null = null;
  for (const p of pairingStore.getState().pairings) {
    const command = commands.get(p.id);
    if (
      command !== undefined &&
      p.orgId === match.orgId &&
      p.providerId === match.providerId &&
      p.target.ownerType === match.target.ownerType &&
      p.target.credentialId === match.target.credentialId &&
      new Date(p.expiresAt).getTime() > now
    ) {
      resumable = { id: p.id, command };
    }
  }
  return resumable;
}

export function markPairingShown(id: string): () => void {
  shown.add(id);
  return () => {
    shown.delete(id);
  };
}

export function isPairingShown(id: string): boolean {
  return shown.has(id);
}
