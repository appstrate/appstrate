// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";

/**
 * The store feature-detects `globalThis.localStorage`, so a Map-backed fake
 * is enough to exercise the persistence path in a DOM-less bun runtime.
 * Installed before importing the store so module-init reads through it too.
 */
class FakeStorage {
  private m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  getItem(key: string): string | null {
    return this.m.has(key) ? (this.m.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.m.set(key, value);
  }
  removeItem(key: string): void {
    this.m.delete(key);
  }
  clear(): void {
    this.m.clear();
  }
  key(i: number): string | null {
    return [...this.m.keys()][i] ?? null;
  }
}

const fakeStorage = new FakeStorage();
(globalThis as { localStorage?: Storage }).localStorage = fakeStorage;

const {
  pairingStore,
  addPendingPairing,
  removePendingPairing,
  readPersistedPairings,
  STORAGE_KEY,
} = await import("../pairing-store");

function reset() {
  fakeStorage.clear();
  pairingStore.setState({ pairings: [] });
}

const future = () => new Date(Date.now() + 5 * 60_000).toISOString();
const past = () => new Date(Date.now() - 1_000).toISOString();

describe("pairingStore", () => {
  beforeEach(reset);

  it("adds a pairing", () => {
    addPendingPairing({ id: "pair_1", providerId: "codex", expiresAt: future(), orgId: "org_a" });
    expect(pairingStore.getState().pairings).toHaveLength(1);
    expect(pairingStore.getState().pairings[0]?.id).toBe("pair_1");
  });

  it("dedups on id (re-add replaces)", () => {
    addPendingPairing({ id: "pair_1", providerId: "codex", expiresAt: future(), orgId: "org_a" });
    addPendingPairing({
      id: "pair_1",
      providerId: "claude-code",
      expiresAt: future(),
      orgId: "org_a",
    });
    const { pairings } = pairingStore.getState();
    expect(pairings).toHaveLength(1);
    expect(pairings[0]?.providerId).toBe("claude-code");
  });

  it("removes a pairing", () => {
    addPendingPairing({ id: "pair_1", providerId: "codex", expiresAt: future(), orgId: "org_a" });
    removePendingPairing("pair_1");
    expect(pairingStore.getState().pairings).toHaveLength(0);
  });

  it("prune drops TTL-expired pairings, keeps live ones", () => {
    addPendingPairing({ id: "live", providerId: "codex", expiresAt: future(), orgId: "org_a" });
    addPendingPairing({ id: "dead", providerId: "codex", expiresAt: past(), orgId: "org_a" });
    pairingStore.getState().prune();
    const ids = pairingStore.getState().pairings.map((p) => p.id);
    expect(ids).toEqual(["live"]);
  });

  it("persists to storage and reloads (survives a page reload)", () => {
    const exp = future();
    addPendingPairing({ id: "pair_1", providerId: "codex", expiresAt: exp, orgId: "org_a" });
    // A fresh load (as on reload) reads it straight back from storage.
    expect(readPersistedPairings()).toEqual([
      { id: "pair_1", providerId: "codex", expiresAt: exp, orgId: "org_a" },
    ]);
  });

  it("persists ONLY non-secret fields (never a token/command)", () => {
    addPendingPairing({ id: "pair_1", providerId: "codex", expiresAt: future(), orgId: "org_a" });
    const raw = fakeStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string) as Record<string, unknown>[];
    expect(Object.keys(parsed[0] ?? {}).sort()).toEqual(["expiresAt", "id", "orgId", "providerId"]);
    expect(raw).not.toContain("token");
    expect(raw).not.toContain("npx");
  });

  it("clears the storage key when the last pairing is removed", () => {
    addPendingPairing({ id: "pair_1", providerId: "codex", expiresAt: future(), orgId: "org_a" });
    removePendingPairing("pair_1");
    expect(fakeStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("ignores corrupt persisted JSON on load", () => {
    fakeStorage.setItem(STORAGE_KEY, "{ this is not valid json");
    expect(readPersistedPairings()).toEqual([]);
  });

  it("ignores a non-array persisted payload", () => {
    fakeStorage.setItem(STORAGE_KEY, JSON.stringify({ id: "pair_1" }));
    expect(readPersistedPairings()).toEqual([]);
  });

  it("drops malformed + TTL-expired entries on load, keeps valid live ones", () => {
    fakeStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        { id: "live", providerId: "codex", expiresAt: future(), orgId: "org_a" },
        { id: "expired", providerId: "codex", expiresAt: past(), orgId: "org_a" },
        { id: "malformed" }, // missing required fields
      ]),
    );
    expect(readPersistedPairings().map((p) => p.id)).toEqual(["live"]);
  });

  it("hydrate mirrors another tab's write (cross-tab sync)", () => {
    const exp = future();
    fakeStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([{ id: "pair_x", providerId: "codex", expiresAt: exp, orgId: "org_a" }]),
    );
    pairingStore.getState().hydrate();
    expect(pairingStore.getState().pairings.map((p) => p.id)).toEqual(["pair_x"]);
  });
});
