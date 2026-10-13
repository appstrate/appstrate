// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import type { PendingPairing } from "../pairing-store";

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

// `localStorage` is process-wide and `bun test` runs many files in one
// process: put back whatever was there once this file is done.
const originalStorage = (globalThis as { localStorage?: Storage }).localStorage;
afterAll(() => {
  if (originalStorage === undefined) delete (globalThis as { localStorage?: Storage }).localStorage;
  else (globalThis as { localStorage?: Storage }).localStorage = originalStorage;
});

const fakeStorage = new FakeStorage();
(globalThis as { localStorage?: Storage }).localStorage = fakeStorage;

const {
  pairingStore,
  addPendingPairing,
  removePendingPairing,
  clearPendingPairings,
  readPersistedPairings,
  resumablePairing,
  markPairingShown,
  isPairingShown,
  STORAGE_KEY,
  UNPOLLED_RETENTION_MS,
} = await import("../pairing-store");

function reset() {
  fakeStorage.clear();
  pairingStore.setState({ pairings: [] });
}

const future = () => new Date(Date.now() + 5 * 60_000).toISOString();
// TTL elapsed, server row still readable: the poll has yet to state the outcome.
const pastTtl = () => new Date(Date.now() - UNPOLLED_RETENTION_MS + 60_000).toISOString();
const pastRetention = () => new Date(Date.now() - UNPOLLED_RETENTION_MS - 1_000).toISOString();

const COMMAND = "npx @appstrate/connect-helper token_secret";

/** A new organization subscription of `codex`, minted in `org_a`, its TTL running. */
function pairing(overrides: Partial<PendingPairing> & { id: string }): PendingPairing {
  return {
    providerId: "codex",
    target: { ownerType: "org" },
    expiresAt: future(),
    orgId: "org_a",
    ...overrides,
  };
}

function writePersisted(entries: unknown[]) {
  fakeStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

describe("pairingStore", () => {
  beforeEach(reset);

  it("adds a pairing", () => {
    addPendingPairing(pairing({ id: "pair_1" }), COMMAND);
    expect(pairingStore.getState().pairings).toHaveLength(1);
    expect(pairingStore.getState().pairings[0]?.id).toBe("pair_1");
  });

  it("dedups on id (re-add replaces)", () => {
    addPendingPairing(pairing({ id: "pair_1" }), COMMAND);
    addPendingPairing(pairing({ id: "pair_1", providerId: "claude-code" }), COMMAND);
    const { pairings } = pairingStore.getState();
    expect(pairings).toHaveLength(1);
    expect(pairings[0]?.providerId).toBe("claude-code");
  });

  it("removes a pairing", () => {
    addPendingPairing(pairing({ id: "pair_1" }), COMMAND);
    removePendingPairing("pair_1");
    expect(pairingStore.getState().pairings).toHaveLength(0);
  });

  it("prune keeps a pairing past its TTL: only its poll ends it", () => {
    addPendingPairing(pairing({ id: "live" }), COMMAND);
    addPendingPairing(pairing({ id: "past_ttl", expiresAt: pastTtl() }), COMMAND);
    pairingStore.getState().prune();
    const ids = pairingStore.getState().pairings.map((p) => p.id);
    expect(ids).toEqual(["live", "past_ttl"]);
    expect(readPersistedPairings().map((p) => p.id)).toEqual(["live", "past_ttl"]);
  });

  it("prune drops a pairing past the unpolled retention", () => {
    addPendingPairing(pairing({ id: "live" }), COMMAND);
    addPendingPairing(pairing({ id: "unpolled", expiresAt: pastRetention() }), COMMAND);
    pairingStore.getState().prune();
    expect(pairingStore.getState().pairings.map((p) => p.id)).toEqual(["live"]);
    const persisted = JSON.parse(fakeStorage.getItem(STORAGE_KEY) as string) as { id: string }[];
    expect(persisted.map((p) => p.id)).toEqual(["live"]);
  });

  it("persists to storage and reloads (survives a page reload)", () => {
    const entry = pairing({ id: "pair_1" });
    addPendingPairing(entry, COMMAND);
    // A fresh load (as on reload) reads it straight back from storage.
    expect(readPersistedPairings()).toEqual([entry]);
  });

  it("persists ONLY non-secret fields (never a token/command)", () => {
    addPendingPairing(pairing({ id: "pair_1" }), COMMAND);
    const raw = fakeStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string) as Record<string, unknown>[];
    expect(Object.keys(parsed[0] ?? {}).sort()).toEqual([
      "expiresAt",
      "id",
      "orgId",
      "providerId",
      "target",
    ]);
    expect(raw).not.toContain("token");
    expect(raw).not.toContain("npx");
  });

  it("clears the storage key when the last pairing is removed", () => {
    addPendingPairing(pairing({ id: "pair_1" }), COMMAND);
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

  it("keeps a pairing past its TTL on load, drops malformed and unretained entries", () => {
    writePersisted([
      pairing({ id: "live" }),
      pairing({ id: "past_ttl", expiresAt: pastTtl() }),
      pairing({ id: "unpolled", expiresAt: pastRetention() }),
      { id: "malformed" }, // missing required fields
      pairing({ id: "bad_date", expiresAt: "not a date" }),
    ]);
    expect(readPersistedPairings().map((p) => p.id)).toEqual(["live", "past_ttl"]);
  });

  it("drops a persisted entry whose target is neither of the two shapes", () => {
    const targetless = { providerId: "codex", expiresAt: future(), orgId: "org_a" };
    writePersisted([
      pairing({ id: "creation", target: { ownerType: "user" } }),
      pairing({ id: "reconnect", target: { credentialId: "cred_1" } }),
      { ...targetless, id: "no_target" },
      { ...targetless, id: "empty", target: {} },
      { ...targetless, id: "unknown_owner", target: { ownerType: "team" } },
      { ...targetless, id: "both", target: { ownerType: "org", credentialId: "cred_1" } },
    ]);
    expect(readPersistedPairings().map((p) => p.id)).toEqual(["creation", "reconnect"]);
  });

  it("clear empties the list and its persisted copy", () => {
    addPendingPairing(pairing({ id: "pair_1" }), COMMAND);
    addPendingPairing(pairing({ id: "pair_2", orgId: "org_b" }), COMMAND);
    clearPendingPairings();
    expect(pairingStore.getState().pairings).toEqual([]);
    expect(fakeStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("hydrate keeps a pairing past its TTL (reload, cross-tab sync)", () => {
    writePersisted([
      pairing({ id: "past_ttl", expiresAt: pastTtl() }),
      pairing({ id: "unpolled", expiresAt: pastRetention() }),
    ]);
    pairingStore.getState().hydrate();
    expect(pairingStore.getState().pairings.map((p) => p.id)).toEqual(["past_ttl"]);
  });

  it("hydrate mirrors another tab's write (cross-tab sync)", () => {
    writePersisted([pairing({ id: "pair_x" })]);
    pairingStore.getState().hydrate();
    expect(pairingStore.getState().pairings.map((p) => p.id)).toEqual(["pair_x"]);
  });
});

describe("resumablePairing", () => {
  beforeEach(reset);

  const match = { orgId: "org_a", providerId: "codex", target: { ownerType: "org" } } as const;

  it("is the pairing of the same org, provider and target, with its command", () => {
    addPendingPairing(pairing({ id: "pair_1" }), COMMAND);
    expect(resumablePairing(match)).toEqual({ id: "pair_1", command: COMMAND });
  });

  it("is the most recent of several", () => {
    addPendingPairing(pairing({ id: "pair_1" }), "npx first");
    addPendingPairing(pairing({ id: "pair_2" }), "npx second");
    expect(resumablePairing(match)).toEqual({ id: "pair_2", command: "npx second" });
  });

  it("matches a reconnect on its credential", () => {
    const target = { credentialId: "cred_1" };
    addPendingPairing(pairing({ id: "pair_1", target }), COMMAND);
    expect(resumablePairing({ ...match, target })?.id).toBe("pair_1");
    expect(resumablePairing({ ...match, target: { credentialId: "cred_2" } })).toBeNull();
    expect(resumablePairing(match)).toBeNull();
  });

  it("is null for another org, provider or owner", () => {
    addPendingPairing(pairing({ id: "pair_1" }), COMMAND);
    expect(resumablePairing({ ...match, orgId: "org_b" })).toBeNull();
    expect(resumablePairing({ ...match, providerId: "claude-code" })).toBeNull();
    expect(resumablePairing({ ...match, target: { ownerType: "user" } })).toBeNull();
  });

  it("is null once the TTL has elapsed", () => {
    addPendingPairing(pairing({ id: "pair_1", expiresAt: pastTtl() }), COMMAND);
    expect(resumablePairing(match)).toBeNull();
  });

  it("is null when this tab holds no command (reload, another tab's pairing)", () => {
    writePersisted([pairing({ id: "pair_elsewhere" })]);
    pairingStore.getState().hydrate();
    expect(pairingStore.getState().pairings.map((p) => p.id)).toEqual(["pair_elsewhere"]);
    expect(resumablePairing(match)).toBeNull();
  });

  // The entry is put back through storage: only the command can be missing.
  function expectCommandForgotten(leave: () => void) {
    addPendingPairing(pairing({ id: "pair_1" }), COMMAND);
    const persisted = fakeStorage.getItem(STORAGE_KEY) as string;
    leave();
    fakeStorage.setItem(STORAGE_KEY, persisted);
    pairingStore.getState().hydrate();
    expect(pairingStore.getState().pairings.map((p) => p.id)).toEqual(["pair_1"]);
    expect(resumablePairing(match)).toBeNull();
  }

  it("forgets the command once the entry is removed", () => {
    expectCommandForgotten(() => removePendingPairing("pair_1"));
  });

  it("forgets the command once the store is cleared", () => {
    expectCommandForgotten(clearPendingPairings);
  });
});

describe("markPairingShown", () => {
  it("marks a pairing as shown until its cleanup runs", () => {
    expect(isPairingShown("pair_1")).toBe(false);
    const unmark = markPairingShown("pair_1");
    expect(isPairingShown("pair_1")).toBe(true);
    expect(isPairingShown("pair_2")).toBe(false);
    unmark();
    expect(isPairingShown("pair_1")).toBe(false);
  });
});
