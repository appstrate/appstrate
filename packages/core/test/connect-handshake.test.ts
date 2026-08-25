// SPDX-License-Identifier: Apache-2.0

/**
 * The origin policy the connect handshake's two directions share.
 *
 * The four surfaces used to hold private copies of the channel name and the
 * message type, aligned by "must match" comments, and the two senders had
 * drifted on the part comments cannot enforce: the OAuth callback page scoped
 * its `postMessage` to the platform origin, the hosted form posted to `"*"`.
 * These are the invariants that make one copy possible.
 */

import { describe, it, expect } from "bun:test";
import {
  INTEGRATION_CONNECT_CHANNEL,
  INTEGRATION_CONNECT_MESSAGE_TYPE,
  acceptsCompletionMessage,
  buildIntegrationConnectCompletion,
  completionMatches,
  integrationConnectOrigin,
  isIntegrationConnectCompletion,
  isIntegrationConnectMessage,
  type IntegrationConnectCompletion,
} from "../src/connect-handshake.ts";

const SELF = "https://app.appstrate.dev";

describe("handshake names", () => {
  it("pins the wire strings the four surfaces agree on", () => {
    // These names are on the wire between a page the API renders and a bundle
    // the SPA ships: changing either breaks every in-flight connect popup on a
    // partially-rolled-out deploy, so they are pinned, not derived.
    expect(INTEGRATION_CONNECT_CHANNEL).toBe("appstrate_integration");
    expect(INTEGRATION_CONNECT_MESSAGE_TYPE).toBe("appstrate:integration_connection");
  });
});

describe("buildIntegrationConnectCompletion", () => {
  it("stamps the discriminator and keeps the correlation fields", () => {
    expect(
      buildIntegrationConnectCompletion({ ok: true, state: "s1", packageId: "@appstrate/gmail" }),
    ).toEqual({
      type: INTEGRATION_CONNECT_MESSAGE_TYPE,
      ok: true,
      state: "s1",
      packageId: "@appstrate/gmail",
    });
  });

  it("carries a failure through so a waiting surface stops spinning", () => {
    const failed = buildIntegrationConnectCompletion({ ok: false, error: "access_denied" });
    expect(failed.ok).toBe(false);
    expect(failed.error).toBe("access_denied");
    expect(isIntegrationConnectCompletion(failed)).toBe(true);
  });
});

describe("integrationConnectOrigin", () => {
  it("reduces a full page URL to its origin", () => {
    expect(integrationConnectOrigin(`${SELF}/connect?token=abc#x`)).toBe(SELF);
    expect(integrationConnectOrigin(`${SELF}/`)).toBe(SELF);
    expect(integrationConnectOrigin("https://app.example.com:8443/x")).toBe(
      "https://app.example.com:8443",
    );
  });
});

describe("isIntegrationConnectCompletion", () => {
  it("accepts only a payload carrying the shared discriminator", () => {
    expect(isIntegrationConnectCompletion({ type: INTEGRATION_CONNECT_MESSAGE_TYPE })).toBe(true);
    expect(isIntegrationConnectCompletion({ type: "something-else" })).toBe(false);
    expect(isIntegrationConnectCompletion("a string from a chatty extension")).toBe(false);
    expect(isIntegrationConnectCompletion(null)).toBe(false);
    expect(isIntegrationConnectCompletion(undefined)).toBe(false);
  });
});

describe("isIntegrationConnectMessage", () => {
  const data = buildIntegrationConnectCompletion({ ok: true, packageId: "@appstrate/gmail" });

  it("accepts a well-formed completion from the receiver's own origin", () => {
    expect(isIntegrationConnectMessage({ origin: SELF, data }, SELF)).toBe(true);
    // The receiver may know itself by a full URL rather than a bare origin.
    expect(isIntegrationConnectMessage({ origin: SELF, data }, `${SELF}/connect`)).toBe(true);
  });

  it("rejects the same completion from any other origin", () => {
    expect(isIntegrationConnectMessage({ origin: "https://evil.example", data }, SELF)).toBe(false);
    // Scheme and port are part of an origin, and a suffix match is not one.
    expect(isIntegrationConnectMessage({ origin: "http://app.appstrate.dev", data }, SELF)).toBe(
      false,
    );
    expect(isIntegrationConnectMessage({ origin: "https://appstrate.dev", data }, SELF)).toBe(
      false,
    );
    expect(isIntegrationConnectMessage({ origin: "null", data }, SELF)).toBe(false);
  });

  it("rejects a same-origin message that is not a completion", () => {
    expect(isIntegrationConnectMessage({ origin: SELF, data: { type: "webpack-hmr" } }, SELF)).toBe(
      false,
    );
  });

  it("fails closed instead of throwing when the receiver's origin is opaque", () => {
    // A sandboxed document's `location.origin` is the literal "null", which is
    // not a parseable URL. Throwing here would throw out of a `message`
    // listener; the safe answer is to trust nothing.
    expect(isIntegrationConnectMessage({ origin: SELF, data }, "null")).toBe(false);
    expect(isIntegrationConnectMessage({ origin: SELF, data }, "")).toBe(false);
  });

  // The unparseable cases above are the ones an equality test survives. These
  // are the ones it does not: a `selfUrl` that PARSES and still serialises to
  // the opaque origin "null" — which is also what every sandboxed sender
  // reports — so `event.origin === self` makes two unrelated nobodies match.
  const OPAQUE_SELF_URLS = [
    "about:blank",
    "data:text/html,<p>connect</p>",
    "file:///Users/x/connect.html",
    "blob:null",
  ];

  it("has an opaque origin for every one of those self URLs", () => {
    // The premise of the test below: these parse, so the try/catch above never
    // sees them, and they all reduce to the same string.
    for (const url of OPAQUE_SELF_URLS) {
      expect(integrationConnectOrigin(url)).toBe("null");
    }
  });

  it("refuses a forged completion when the receiver's own origin is opaque", () => {
    for (const url of OPAQUE_SELF_URLS) {
      // The attack: any sandboxed frame posts with origin "null" and matches.
      expect(isIntegrationConnectMessage({ origin: "null", data }, url)).toBe(false);
      // And an opaque receiver trusts nobody at all, not just not-"null".
      expect(isIntegrationConnectMessage({ origin: SELF, data }, url)).toBe(false);
    }
  });

  it("refuses an opaque sender against a real receiver origin", () => {
    expect(isIntegrationConnectMessage({ origin: "null", data }, SELF)).toBe(false);
    expect(isIntegrationConnectMessage({ origin: "null", data }, `${SELF}/connect`)).toBe(false);
  });
});

/**
 * Correlation — WHICH waiting surface a completion is for.
 *
 * These cases lived in `packages/module-chat` while the predicates did, and the
 * dashboard connect popup could not import either, so it re-implemented the
 * gate with no correlation at all: any successful completion, for any package,
 * settled its promise. Both live here now because both carriers of this
 * handshake fan out, so every surface has to answer the same question the same
 * way.
 */
function detail(
  overrides: Partial<IntegrationConnectCompletion> = {},
): IntegrationConnectCompletion {
  return { type: INTEGRATION_CONNECT_MESSAGE_TYPE, ok: true, ...overrides };
}

describe("completionMatches", () => {
  it("rejects a foreign message type", () => {
    expect(completionMatches(detail({ type: "other" }), {})).toBe(false);
    expect(completionMatches(undefined, {})).toBe(false);
  });

  it("matches on exact state when both sides carry one", () => {
    const target = { state: "s1" };
    expect(completionMatches(detail({ state: "s1" }), target)).toBe(true);
    expect(completionMatches(detail({ state: "s2" }), target)).toBe(false);
  });

  // An OAuth card can mount without a packageId (it comes out of the model's
  // tool args) while the callback still emits one. The state pair identifies
  // the flow exactly, so it decides — the package rule below never sees this.
  it("lets an exact state settle it even when the target has no packageId", () => {
    const target = { state: "s1" };
    expect(completionMatches(detail({ state: "s1", packageId: "@appstrate/gmail" }), target)).toBe(
      true,
    );
  });

  it("rejects a completion for another package (the cross-card resume bug)", () => {
    // Regression: the hosted-connect offer (`connect_url`) has no state, so a
    // stateless surface must still ignore a completion addressed to a different
    // package — connecting @appstrate/gmail must not resume the
    // @appstrate/gmail-mcp card, nor settle a popup opened for it.
    const target = { packageId: "@appstrate/gmail-mcp" };
    expect(completionMatches(detail({ packageId: "@appstrate/gmail" }), target)).toBe(false);
    expect(completionMatches(detail({ packageId: "@appstrate/gmail-mcp" }), target)).toBe(true);
  });

  it("accepts a context-less completion (error pages emit no state/packageId)", () => {
    // The callback page answers "Missing connect token" / "invalid or expired"
    // before it has resolved a package, so these carry neither identifier. They
    // only ever surface an error, never an append — every waiting surface takes
    // them, identified or not. This is the ONE case the permissive branch is for.
    const target = { packageId: "@appstrate/gmail" };
    expect(completionMatches(detail({ ok: false, error: "Missing connect token" }), target)).toBe(
      true,
    );
    expect(completionMatches(detail({ ok: false, error: "Missing connect token" }), {})).toBe(true);
  });

  it("rejects a package-addressed completion on a surface that identifies nothing", () => {
    // The permissive direction, and the bug it was: `target.packageId` is
    // optional and a card can genuinely mount without one, so a predicate that
    // only narrowed when the TARGET carried an id narrowed nothing here — and
    // an unidentified card resumed on a foreign integration's completion. An
    // unidentified surface must fail closed, not accept everything.
    expect(completionMatches(detail({ packageId: "@appstrate/gmail" }), {})).toBe(false);
    // …including when it carries a state the completion does not, so the state
    // rule above cannot settle it either.
    expect(completionMatches(detail({ packageId: "@appstrate/gmail" }), { state: "s1" })).toBe(
      false,
    );
  });
});

describe("acceptsCompletionMessage", () => {
  // The listener checked the payload and never `event.origin`, which is a
  // MUST-level failure (RFC 10017 §6.3.3.3): every completion is sent by a page
  // the platform serves, so any other origin is a forgery. An accepted forgery
  // flips the surface to "connected" — in chat it appends a resume turn, telling
  // the model an integration is usable when it is not.
  const TARGET = { packageId: "@appstrate/gmail" };

  it("rejects a well-formed completion from a foreign origin", () => {
    const forged = { origin: "https://evil.example", data: detail(TARGET) };
    expect(acceptsCompletionMessage(forged, SELF, TARGET)).toBe(false);
  });

  it("accepts the same completion from the page's own origin", () => {
    // Positive control: the rejection above must come from the origin, not from
    // a payload this gate would have refused anyway.
    const genuine = { origin: SELF, data: detail(TARGET) };
    expect(acceptsCompletionMessage(genuine, SELF, TARGET)).toBe(true);
  });

  it("still applies the payload correlation on a same-origin message", () => {
    const other = { origin: SELF, data: detail({ packageId: "@appstrate/gmail-mcp" }) };
    expect(acceptsCompletionMessage(other, SELF, TARGET)).toBe(false);
  });

  it("rejects everything when the page's own origin is opaque", () => {
    // A sandboxed document reports the literal string "null", which is not a
    // parseable origin — fail closed rather than throw out of the listener.
    const genuine = { origin: SELF, data: detail(TARGET) };
    expect(acceptsCompletionMessage(genuine, "null", TARGET)).toBe(false);
  });
});
