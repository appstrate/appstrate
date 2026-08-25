// SPDX-License-Identifier: Apache-2.0

/**
 * The chat module's OWN half of the connect-card story: the once-per-package
 * resume claim.
 *
 * The correlation predicates (`completionMatches`, `acceptsCompletionMessage`)
 * that used to be tested here moved to `@appstrate/core/connect-handshake`
 * together with the code, and their cases moved with them
 * (`packages/core/test/connect-handshake.test.ts`). They are handshake rules
 * every connect surface applies, not chat behaviour; leaving their tests in
 * this package is what let the SPA's connect popup ship with no correlation at
 * all while a green suite over here described the rule as settled.
 */

import { describe, it, expect } from "bun:test";
import { claimResume } from "../src/ui/auth-offer.ts";

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
