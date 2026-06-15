// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { pairingStore, addPendingPairing, removePendingPairing } from "../pairing-store";

function reset() {
  // Drop whatever the singleton currently holds.
  for (const p of [...pairingStore.getState().pairings]) removePendingPairing(p.id);
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
});
