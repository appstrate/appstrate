// SPDX-License-Identifier: Apache-2.0

/**
 * The chat module's OWN half of the connect-card story: the once-per-burst
 * resume claim, along both axes cards fan out on (package, tool call).
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
    expect(claimResume({ packageId: "@test/claim-a" }, t0)).toBe(true);
    expect(claimResume({ packageId: "@test/claim-a" }, t0 + 5)).toBe(false);
    expect(claimResume({ packageId: "@test/claim-a" }, t0 + 29_999)).toBe(false);
  });

  it("allows a fresh claim after the TTL (legitimate later reconnect)", () => {
    const t0 = 2_000_000;
    expect(claimResume({ packageId: "@test/claim-b" }, t0)).toBe(true);
    expect(claimResume({ packageId: "@test/claim-b" }, t0 + 30_000)).toBe(true);
  });

  it("scopes claims per package when the cards come from different tool calls", () => {
    const t0 = 3_000_000;
    expect(claimResume({ packageId: "@test/claim-c", toolCallId: "call-c" }, t0)).toBe(true);
    expect(claimResume({ packageId: "@test/claim-d", toolCallId: "call-d" }, t0)).toBe(true);
  });

  // Issue #1207: a run-kickoff 412 lists every integration still to connect and
  // the chat renders one card per offer. They are DIFFERENT packages, so only
  // the tool-call axis stops the second completion from appending a second
  // resume — i.e. from opening a second concurrent turn.
  it("blocks a sibling card of the same tool call, even on another package", () => {
    const t0 = 5_000_000;
    expect(claimResume({ packageId: "@test/gmail", toolCallId: "call-1" }, t0)).toBe(true);
    expect(claimResume({ packageId: "@test/clickup", toolCallId: "call-1" }, t0 + 900)).toBe(false);
  });

  it("still blocks two cards on the same package from different tool calls", () => {
    const t0 = 6_000_000;
    expect(claimResume({ packageId: "@test/retry", toolCallId: "call-a" }, t0)).toBe(true);
    expect(claimResume({ packageId: "@test/retry", toolCallId: "call-b" }, t0 + 10)).toBe(false);
  });

  it("never blocks a card that can identify itself on neither axis", () => {
    expect(claimResume({}, 4_000_000)).toBe(true);
    expect(claimResume({}, 4_000_000)).toBe(true);
  });
});
