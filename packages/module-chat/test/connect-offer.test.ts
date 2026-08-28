// SPDX-License-Identifier: Apache-2.0

/**
 * Single-pass connect-offer split: redaction and extraction are the same walk,
 * so whatever leaves the payload surfaces as the typed offer — and ONLY there.
 * Regression coverage for issue #906 (the UI scraper used to pick the redaction
 * placeholder out of the model channel and render it as a relative URL).
 */

import { describe, expect, it } from "bun:test";
import { REDACTED_CONNECT_LINK, splitConnectPayload, splitJsonText } from "../src/connect-offer.ts";

const URL_ = "https://app.example.com/api/integrations/connect/start?token=SECRET";

describe("splitConnectPayload", () => {
  it("redacts and captures in one pass, with sibling state/expires_at", () => {
    const payload = {
      status: 200,
      body: { connect_url: URL_, state: "st-1", expires_at: 1784142529000 },
    };
    const { redacted, offer } = splitConnectPayload(payload);
    expect(JSON.stringify(redacted)).not.toContain("token=SECRET");
    expect((redacted as { body: { connect_url: string } }).body.connect_url).toBe(
      REDACTED_CONNECT_LINK,
    );
    expect(offer).toEqual({ connect_url: URL_, state: "st-1", expires_at: 1784142529000 });
  });

  it("redacts a non-URL string under a connect key but never offers it", () => {
    const { redacted, offer } = splitConnectPayload({ connect_url: REDACTED_CONNECT_LINK });
    expect((redacted as { connect_url: string }).connect_url).toBe(REDACTED_CONNECT_LINK);
    expect(offer).toBeNull();
  });

  it("normalizes a parsed HTTP(S) offer before exposing it to the UI", () => {
    const { redacted, offer } = splitConnectPayload({
      connect_url: "HTTPS://EXAMPLE.COM/Connect",
    });
    expect((redacted as { connect_url: string }).connect_url).toBe(REDACTED_CONNECT_LINK);
    expect(offer).toEqual({ connect_url: "https://example.com/Connect" });
  });

  it("redacts malformed and non-HTTP(S) values without offering them", () => {
    for (const connect_url of ["https://", "javascript:alert(1)", "//evil.example/connect"]) {
      const { redacted, offer } = splitConnectPayload({ connect_url });
      expect((redacted as { connect_url: string }).connect_url).toBe(REDACTED_CONNECT_LINK);
      expect(offer).toBeNull();
    }
  });

  it("returns the same reference and no offer when nothing matches", () => {
    const payload = { ok: true, nested: { a: [1, 2] } };
    const { redacted, offer } = splitConnectPayload(payload);
    expect(redacted).toBe(payload);
    expect(offer).toBeNull();
  });

  // The no-dual-read half of the pair above. `CONNECT_URL_KEYS` and
  // `offerFromNode` read the wire spelling ONLY — what
  // `routes/integrations.ts` actually emits (`connect_url` / `auth_url`, and
  // `expires_at` beside them). This fails the moment anyone reinstates a
  // `obj.expires_at ?? obj.expiresAt` fallback or a `connectUrl` key: the camel
  // twin would start being redacted and captured, and neither expectation here
  // would hold.
  it("reads the wire spelling only — a camelCase twin is neither redacted nor offered", () => {
    const payload = { connectUrl: URL_, connect_url: URL_, expiresAt: 1784142529000 };
    const { redacted, offer } = splitConnectPayload(payload);
    expect((redacted as { connectUrl: string }).connectUrl).toBe(URL_);
    expect((redacted as { connect_url: string }).connect_url).toBe(REDACTED_CONNECT_LINK);
    expect(offer).toEqual({ connect_url: URL_ });
  });

  it("captures the first offer when several are present, redacting all", () => {
    const payload = {
      first: { auth_url: "https://a.example/one" },
      second: { auth_url: "https://a.example/two" },
    };
    const { redacted, offer } = splitConnectPayload(payload);
    expect(offer).toEqual({ connect_url: "https://a.example/one" });
    expect(JSON.stringify(redacted)).not.toContain("a.example/two");
  });
});

describe("splitJsonText", () => {
  it("splits a JSON text block, leaving non-JSON byte-identical", () => {
    const json = JSON.stringify({ connect_url: URL_ });
    const split = splitJsonText(json);
    expect(split.text).not.toContain("token=SECRET");
    expect(split.offer).toEqual({ connect_url: URL_ });

    const prose = "plain prose, no JSON";
    expect(splitJsonText(prose)).toEqual({ text: prose, offer: null });
  });
});
