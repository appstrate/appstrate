// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { completionMatches, claimResume, type CompletionDetail } from "../src/ui/auth-offer.ts";

const TYPE = "appstrate:integration_connection";

function detail(overrides: Partial<CompletionDetail> = {}): CompletionDetail {
  return { type: TYPE, ok: true, ...overrides };
}

describe("completionMatches", () => {
  it("rejects a foreign message type", () => {
    expect(completionMatches(detail({ type: "other" }), { messageType: TYPE })).toBe(false);
    expect(completionMatches(undefined, { messageType: TYPE })).toBe(false);
  });

  it("matches on exact state when both sides carry one", () => {
    const card = { messageType: TYPE, state: "s1" };
    expect(completionMatches(detail({ state: "s1" }), card)).toBe(true);
    expect(completionMatches(detail({ state: "s2" }), card)).toBe(false);
  });

  it("rejects a completion for another package (the cross-card resume bug)", () => {
    // Regression: the hosted-connect offer (`connect_url`) has no state, so a
    // stateless card must still ignore a completion addressed to a different
    // package — connecting @appstrate/gmail must not resume the
    // @appstrate/gmail-mcp card.
    const card = { messageType: TYPE, packageId: "@appstrate/gmail-mcp" };
    expect(completionMatches(detail({ packageId: "@appstrate/gmail" }), card)).toBe(false);
    expect(completionMatches(detail({ packageId: "@appstrate/gmail-mcp" }), card)).toBe(true);
  });

  it("accepts a context-less completion (error pages emit no state/packageId)", () => {
    const card = { messageType: TYPE, packageId: "@appstrate/gmail" };
    expect(completionMatches(detail({ ok: false, error: "Missing connect token" }), card)).toBe(
      true,
    );
  });

  it("accepts a package-addressed completion on a card that lacks a packageId", () => {
    expect(
      completionMatches(detail({ packageId: "@appstrate/gmail" }), { messageType: TYPE }),
    ).toBe(true);
  });
});

describe("claimResume", () => {
  it("lets the first card claim and blocks siblings within the TTL", () => {
    const t0 = 1_000_000;
    expect(claimResume("@test/claim-a", t0)).toBe(true);
    expect(claimResume("@test/claim-a", t0 + 5)).toBe(false);
    expect(claimResume("@test/claim-a", t0 + 29_999)).toBe(false);
  });

  it("allows a fresh claim after the TTL (legitimate later reconnect)", () => {
    const t0 = 2_000_000;
    expect(claimResume("@test/claim-b", t0)).toBe(true);
    expect(claimResume("@test/claim-b", t0 + 30_000)).toBe(true);
  });

  it("scopes claims per package", () => {
    const t0 = 3_000_000;
    expect(claimResume("@test/claim-c", t0)).toBe(true);
    expect(claimResume("@test/claim-d", t0)).toBe(true);
  });

  it("never blocks a card without a packageId", () => {
    expect(claimResume(undefined, 4_000_000)).toBe(true);
    expect(claimResume(undefined, 4_000_000)).toBe(true);
  });
});
