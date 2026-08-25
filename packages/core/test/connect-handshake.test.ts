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
  buildIntegrationConnectCompletion,
  integrationConnectOrigin,
  isIntegrationConnectCompletion,
  isIntegrationConnectMessage,
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
});
