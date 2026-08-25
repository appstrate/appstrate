// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { INTEGRATION_CONNECT_MESSAGE_TYPE as TYPE } from "@appstrate/core/connect-handshake";
import {
  acceptsCompletionMessage,
  completionMatches,
  claimResume,
  type CompletionDetail,
} from "../src/ui/auth-offer.ts";

function detail(overrides: Partial<CompletionDetail> = {}): CompletionDetail {
  return { type: TYPE, ok: true, ...overrides };
}

describe("completionMatches", () => {
  it("rejects a foreign message type", () => {
    expect(completionMatches(detail({ type: "other" }), {})).toBe(false);
    expect(completionMatches(undefined, {})).toBe(false);
  });

  it("matches on exact state when both sides carry one", () => {
    const card = { state: "s1" };
    expect(completionMatches(detail({ state: "s1" }), card)).toBe(true);
    expect(completionMatches(detail({ state: "s2" }), card)).toBe(false);
  });

  it("rejects a completion for another package (the cross-card resume bug)", () => {
    // Regression: the hosted-connect offer (`connect_url`) has no state, so a
    // stateless card must still ignore a completion addressed to a different
    // package — connecting @appstrate/gmail must not resume the
    // @appstrate/gmail-mcp card.
    const card = { packageId: "@appstrate/gmail-mcp" };
    expect(completionMatches(detail({ packageId: "@appstrate/gmail" }), card)).toBe(false);
    expect(completionMatches(detail({ packageId: "@appstrate/gmail-mcp" }), card)).toBe(true);
  });

  it("accepts a context-less completion (error pages emit no state/packageId)", () => {
    const card = { packageId: "@appstrate/gmail" };
    expect(completionMatches(detail({ ok: false, error: "Missing connect token" }), card)).toBe(
      true,
    );
  });

  it("accepts a package-addressed completion on a card that lacks a packageId", () => {
    expect(completionMatches(detail({ packageId: "@appstrate/gmail" }), {})).toBe(true);
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

describe("acceptsCompletionMessage", () => {
  // The card's `message` listener checked the payload and never `event.origin`,
  // which is a MUST-level failure (RFC 10017 §6.3.3.3): every completion is
  // sent by a page the platform serves, so any other origin is a forgery. An
  // accepted forgery flips the card to "connected" and appends a resume turn,
  // telling the model an integration is usable when it is not.
  const SELF = "https://app.appstrate.dev";
  const CARD = { packageId: "@appstrate/gmail" };

  it("rejects a well-formed completion from a foreign origin", () => {
    const forged = { origin: "https://evil.example", data: detail(CARD) };
    expect(acceptsCompletionMessage(forged, SELF, CARD)).toBe(false);
  });

  it("accepts the same completion from the page's own origin", () => {
    // Positive control: the rejection above must come from the origin, not from
    // a payload this gate would have refused anyway.
    const genuine = { origin: SELF, data: detail(CARD) };
    expect(acceptsCompletionMessage(genuine, SELF, CARD)).toBe(true);
  });

  it("still applies the payload correlation on a same-origin message", () => {
    const other = { origin: SELF, data: detail({ packageId: "@appstrate/gmail-mcp" }) };
    expect(acceptsCompletionMessage(other, SELF, CARD)).toBe(false);
  });

  it("rejects everything when the page's own origin is opaque", () => {
    // A sandboxed document reports the literal string "null", which is not a
    // parseable origin — fail closed rather than throw out of the listener.
    const genuine = { origin: SELF, data: detail(CARD) };
    expect(acceptsCompletionMessage(genuine, "null", CARD)).toBe(false);
  });
});
