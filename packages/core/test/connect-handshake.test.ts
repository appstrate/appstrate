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

  // The cases above are the ones a chain of `if`s gets right by accident. These
  // are the ones it got wrong: a completion carrying ONLY a state. It names a
  // specific flow, so it is not context-less — but every predicate that reached
  // its permissive tail on `!detail.packageId` handed it to everyone.
  //
  // It is not hypothetical. `apps/api/src/routes/integrations.ts` emits exactly
  // this shape on the OAuth callback's early failures (:393 provider refused,
  // :401 missing `code`, :425/:429 the token exchange threw), all of them
  // `popupHtmlError(msg, { state })` — no packageId, because the package is only
  // known once the signed state is decoded, which is the step that failed.

  it("rejects a state-only completion on a surface waiting for a package", () => {
    // The production cell. A card mounted from a hosted-connect offer carries a
    // packageId and NO state (that flow mints its state later, at
    // /connect/start click time), so it shares nothing with this completion —
    // yet it used to take it, and a Gmail OAuth failure drove the ClickUp card
    // into its error state.
    const clickupCard = { packageId: "@appstrate/clickup" };
    const gmailOAuthFailure = detail({
      ok: false,
      state: "gmail-flow-nonce",
      error: "Missing required parameters",
    });
    expect(completionMatches(gmailOAuthFailure, clickupCard)).toBe(false);
  });

  it("rejects a state-only completion on a surface that identifies nothing", () => {
    // Same completion, the target the docstring promises fails CLOSED. A state
    // is an identifier: a completion carrying one is addressed to the flow that
    // minted it and to nothing else.
    expect(completionMatches(detail({ ok: false, state: "some-nonce" }), {})).toBe(false);
  });

  it("still delivers a state-only failure to the card that minted that state", () => {
    // The positive control for the two rejections above, and the reason the rule
    // is "an identifier BOTH sides carry must agree" rather than "the target
    // must know everything the completion knows". The card holds a packageId
    // this completion never names; an identifier only one side carries neither
    // addresses nor contradicts, so it must not reject either.
    const failure = detail({ ok: false, state: "s1", error: "OAuth error: access_denied" });
    expect(completionMatches(failure, { state: "s1" })).toBe(true);
    expect(completionMatches(failure, { state: "s1", packageId: "@appstrate/gmail" })).toBe(true);
    expect(completionMatches(failure, { state: "s2", packageId: "@appstrate/gmail" })).toBe(false);
  });

  it("does not let a matching state override a mismatched packageId", () => {
    // A disagreement on EITHER identifier is fatal on its own — this is an AND,
    // not a first-match chain. The completion's packageId is derived from the
    // very state it echoes (`result.packageId`, read out of the signed state),
    // so a genuine pair can never disagree; a disagreeing pair is a
    // contradiction, and resuming on it is the cross-card resume this predicate
    // exists to stop.
    const target = { state: "s1", packageId: "@appstrate/gmail" };
    expect(
      completionMatches(detail({ state: "s1", packageId: "@appstrate/clickup" }), target),
    ).toBe(false);
    // …and the mirror: a matching packageId does not rescue a stale state.
    expect(completionMatches(detail({ state: "s2", packageId: "@appstrate/gmail" }), target)).toBe(
      false,
    );
  });
});

/**
 * The whole predicate, pinned as a table.
 *
 * The named cases above each argue one cell. This is the exhaustive sweep, and
 * it is here because every bug this predicate has had was a cell nobody thought
 * to name: the permissive tail was reached by a shape the chain of `if`s was not
 * written against. Four targets — what a waiting surface can know — against
 * every combination of what a completion can carry.
 */
const ST = "s1";
const OTHER_ST = "s2";
const PKG = "@appstrate/gmail";
const OTHER_PKG = "@appstrate/clickup";

const MATRIX_TARGETS: ReadonlyArray<[string, { state?: string; packageId?: string }]> = [
  ["identifies nothing", {}],
  ["state only", { state: ST }],
  ["packageId only", { packageId: PKG }],
  ["state + packageId", { state: ST, packageId: PKG }],
];

const MATRIX_COMPLETIONS: ReadonlyArray<[string, Partial<IntegrationConnectCompletion>]> = [
  ["identifies nothing", {}],
  ["state matching", { state: ST }],
  ["state mismatching", { state: OTHER_ST }],
  ["packageId matching", { packageId: PKG }],
  ["packageId mismatching", { packageId: OTHER_PKG }],
  ["both matching", { state: ST, packageId: PKG }],
  ["both mismatching", { state: OTHER_ST, packageId: OTHER_PKG }],
  ["state matching + packageId mismatching", { state: ST, packageId: OTHER_PKG }],
  ["packageId matching + state mismatching", { state: OTHER_ST, packageId: PKG }],
];

/**
 * One row per target, one flag per completion shape in `MATRIX_COMPLETIONS`
 * order. `A` = accepted, `.` = refused.
 *
 * Read the shape of it, not just the cells: the ONLY completion an unidentified
 * target accepts is the one that identifies nothing (the context-less error
 * pages), and no row accepts a completion it disagrees with on either
 * identifier.
 */
const EXPECTED_ACCEPTANCE: Readonly<Record<string, string>> = {
  "identifies nothing": "A........",
  "state only": "AA...A.A.",
  "packageId only": "A..A.A..A",
  "state + packageId": "AA.A.A...",
};

describe("completionMatches — full correlation matrix", () => {
  it("accepts exactly the pinned cells", () => {
    const actual: Record<string, string> = {};
    for (const [targetName, target] of MATRIX_TARGETS) {
      actual[targetName] = MATRIX_COMPLETIONS.map(([, overrides]) =>
        completionMatches(detail(overrides), target) ? "A" : ".",
      ).join("");
    }
    expect(actual).toEqual(EXPECTED_ACCEPTANCE);
  });

  it("accepts nothing at all from an origin that is not the receiver's own", () => {
    // The origin gate sits in front of the correlation and is unaffected by it:
    // every one of the 36 cells above must be refused for a foreign sender and
    // for the opaque origin every sandboxed document reports. A correlation
    // change that loosened this would be the serious one.
    for (const origin of ["https://evil.example", "http://app.appstrate.dev", "null"]) {
      for (const [, target] of MATRIX_TARGETS) {
        for (const [, overrides] of MATRIX_COMPLETIONS) {
          expect(acceptsCompletionMessage({ origin, data: detail(overrides) }, SELF, target)).toBe(
            false,
          );
        }
      }
    }
  });
});

/**
 * Every payload the platform actually emits, against the surfaces that wait for
 * it. The matrix above pins the predicate; this pins that the predicate still
 * carries the product — a narrowing that drops a real delivery is a regression
 * even when every cell reads defensible.
 *
 * Senders: `popupHtmlError` / `popupHtmlClose` in
 * `apps/api/src/routes/integrations.ts` (the OAuth callback and /connect/start)
 * and `publishConnectCompletion` from `apps/web/src/pages/hosted-connect.tsx`.
 */
describe("completionMatches — the payloads the platform emits", () => {
  // A card whose tool args carried no packageId; correlates by state alone.
  const oauthCardStateOnly = { state: ST };
  // A card mounted from a hosted-connect offer: packageId, never a state.
  const hostedCard = { packageId: PKG };
  // The SPA connect popup — `input.packageId` is required, so always this shape.
  const spaPopup = { packageId: PKG };

  it("delivers the OAuth callback success to every surface that flow can have", () => {
    // integrations.ts:468 — popupHtmlClose({ state, packageId }).
    const success = detail({ ok: true, state: ST, packageId: PKG });
    expect(completionMatches(success, oauthCardStateOnly)).toBe(true);
    expect(completionMatches(success, hostedCard)).toBe(true);
    expect(completionMatches(success, spaPopup)).toBe(true);
    expect(completionMatches(success, { state: ST, packageId: PKG })).toBe(true);
    // …and to no one else.
    expect(completionMatches(success, { packageId: OTHER_PKG })).toBe(false);
    expect(completionMatches(success, {})).toBe(false);
  });

  it("delivers the identified callback failures the same way", () => {
    // integrations.ts:462/465 — the package is known by then, so these carry it.
    const failure = detail({ ok: false, state: ST, packageId: PKG, error: "identity_mismatch" });
    expect(completionMatches(failure, oauthCardStateOnly)).toBe(true);
    expect(completionMatches(failure, hostedCard)).toBe(true);
    expect(completionMatches(failure, { packageId: OTHER_PKG })).toBe(false);
  });

  it("delivers the hosted form's success to the surface that opened it", () => {
    // hosted-connect.tsx:89 — { ok: true, packageId }, no state: that flow has
    // none by design.
    const submitted = detail({ ok: true, packageId: PKG });
    expect(completionMatches(submitted, hostedCard)).toBe(true);
    expect(completionMatches(submitted, spaPopup)).toBe(true);
    expect(completionMatches(submitted, { state: ST, packageId: PKG })).toBe(true);
    expect(completionMatches(submitted, { packageId: OTHER_PKG })).toBe(false);
    expect(completionMatches(submitted, oauthCardStateOnly)).toBe(false);
  });

  it("delivers the context-less /connect/start errors to everyone", () => {
    // integrations.ts:864/866/876/880/898/925 — popupHtmlError(msg, {}), emitted
    // before the token resolved a package or a state. This is the carve-out, and
    // it is the reason a surface with no context can still show an error at all.
    for (const msg of [
      "Missing connect token",
      "This connect link is invalid or expired.",
      "This integration is no longer available.",
      "This connect link has already been used.",
      "This integration cannot be connected.",
      "Could not start the connection. Please try again.",
    ]) {
      const contextLess = detail({ ok: false, error: msg });
      for (const [, target] of MATRIX_TARGETS) {
        expect(completionMatches(contextLess, target)).toBe(true);
      }
    }
  });

  it("confines the state-only callback failures to the flow that minted the state", () => {
    // integrations.ts:393/401/425/429 — popupHtmlError(msg, { state }). These
    // reach the surface holding that state and no other. A packageId-only
    // surface waits instead of showing another integration's error; the callback
    // page shows the user the failure itself. Widening the SENDER (giving these
    // paths their packageId) is what would reach that surface — not widening
    // this predicate, which would reach every surface.
    const earlyFailure = detail({ ok: false, state: ST, error: "Missing required parameters" });
    expect(completionMatches(earlyFailure, oauthCardStateOnly)).toBe(true);
    expect(completionMatches(earlyFailure, { state: ST, packageId: PKG })).toBe(true);
    expect(completionMatches(earlyFailure, hostedCard)).toBe(false);
    expect(completionMatches(earlyFailure, spaPopup)).toBe(false);
    expect(completionMatches(earlyFailure, {})).toBe(false);
  });

  it("still delivers the one early failure that carries no state at all", () => {
    // integrations.ts:401 is `if (!code || !state)`: when it is the STATE that is
    // missing, the same line emits `{ state: undefined }` — a context-less error,
    // which every surface takes. The two shapes of one call site.
    expect(completionMatches(detail({ ok: false, error: "Missing required parameters" }), {})).toBe(
      true,
    );
    expect(
      completionMatches(detail({ ok: false, error: "Missing required parameters" }), hostedCard),
    ).toBe(true);
  });
});

describe("acceptsCompletionMessage", () => {
  // The listener checked the payload and never `event.origin`, which is a
  // Unauthenticated-listener failure: every completion is sent by a page
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
