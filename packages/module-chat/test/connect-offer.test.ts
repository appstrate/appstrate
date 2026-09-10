// SPDX-License-Identifier: Apache-2.0

/**
 * Single-pass connect-offer split: redaction and extraction are the same walk,
 * so whatever leaves the payload surfaces as a typed offer — and ONLY there.
 * Regression coverage for issue #906 (the UI scraper used to pick the redaction
 * placeholder out of the model channel and render it as a relative URL) and for
 * issue #1207 (capturing only the first URL scrubbed the rest for the UI too).
 */

import { describe, expect, it } from "bun:test";
import {
  mergeConnectOffers,
  REDACTED_CONNECT_LINK,
  splitConnectPayload,
  splitJsonText,
} from "../src/connect-offer.ts";

const URL_ = "https://app.example.com/api/integrations/connect/start?token=SECRET";

describe("splitConnectPayload", () => {
  it("redacts and captures in one pass, with sibling state/expires_at", () => {
    const payload = {
      status: 200,
      body: { connect_url: URL_, state: "st-1", expires_at: 1784142529000 },
    };
    const { redacted, offers } = splitConnectPayload(payload);
    expect(JSON.stringify(redacted)).not.toContain("token=SECRET");
    expect((redacted as { body: { connect_url: string } }).body.connect_url).toBe(
      REDACTED_CONNECT_LINK,
    );
    expect(offers).toEqual([{ connect_url: URL_, state: "st-1", expires_at: 1784142529000 }]);
  });

  it("redacts a non-URL string under a connect key but never offers it", () => {
    const { redacted, offers } = splitConnectPayload({ connect_url: REDACTED_CONNECT_LINK });
    expect((redacted as { connect_url: string }).connect_url).toBe(REDACTED_CONNECT_LINK);
    expect(offers).toEqual([]);
  });

  it("normalizes a parsed HTTP(S) offer before exposing it to the UI", () => {
    const { redacted, offers } = splitConnectPayload({
      connect_url: "HTTPS://EXAMPLE.COM/Connect",
    });
    expect((redacted as { connect_url: string }).connect_url).toBe(REDACTED_CONNECT_LINK);
    expect(offers).toEqual([{ connect_url: "https://example.com/Connect" }]);
  });

  it("redacts malformed and non-HTTP(S) values without offering them", () => {
    for (const connect_url of ["https://", "javascript:alert(1)", "//evil.example/connect"]) {
      const { redacted, offers } = splitConnectPayload({ connect_url });
      expect((redacted as { connect_url: string }).connect_url).toBe(REDACTED_CONNECT_LINK);
      expect(offers).toEqual([]);
    }
  });

  it("returns the same reference and no offer when nothing matches", () => {
    const payload = { ok: true, nested: { a: [1, 2] } };
    const { redacted, offers } = splitConnectPayload(payload);
    expect(redacted).toBe(payload);
    expect(offers).toEqual([]);
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
    const { redacted, offers } = splitConnectPayload(payload);
    expect((redacted as { connectUrl: string }).connectUrl).toBe(URL_);
    expect((redacted as { connect_url: string }).connect_url).toBe(REDACTED_CONNECT_LINK);
    expect(offers).toEqual([{ connect_url: URL_ }]);
  });

  // Issue #1207: a readiness error lists one connect link per integration still
  // to connect. Capturing only the first redacted the rest for the UI as well as
  // for the model, so the second integration could never be connected.
  it("captures every offer in walk order, redacting all, with sibling metadata", () => {
    const payload = {
      first: { auth_url: "https://a.example/one", state: "st-1" },
      second: { auth_url: "https://a.example/two", expires_at: 1784142529000 },
    };
    const { redacted, offers } = splitConnectPayload(payload);
    expect(offers).toEqual([
      { connect_url: "https://a.example/one", state: "st-1" },
      { connect_url: "https://a.example/two", expires_at: 1784142529000 },
    ]);
    const text = JSON.stringify(redacted);
    expect(text).not.toContain("a.example/one");
    expect(text).not.toContain("a.example/two");
  });

  it("walks into nested arrays, keeping array order", () => {
    const payload = {
      integrations: [
        { id: "@a/gmail", auth: [{ connect_url: "https://a.example/one" }] },
        { id: "@a/clickup", auth: [{ connect_url: "https://a.example/two" }] },
      ],
    };
    const { offers } = splitConnectPayload(payload);
    expect(offers).toEqual([
      { connect_url: "https://a.example/one" },
      { connect_url: "https://a.example/two" },
    ]);
  });

  it("dedupes the same URL, keeping the first sibling metadata", () => {
    const payload = {
      detail: { connect_url: URL_, state: "st-1" },
      // Same link echoed in a summary block, with different siblings.
      summary: { connect_url: URL_, state: "st-2" },
    };
    const { offers } = splitConnectPayload(payload);
    expect(offers).toEqual([{ connect_url: URL_, state: "st-1" }]);
  });
});

describe("splitJsonText", () => {
  it("splits a JSON text block, leaving non-JSON byte-identical", () => {
    const json = JSON.stringify({ connect_url: URL_ });
    const split = splitJsonText(json);
    expect(split.text).not.toContain("token=SECRET");
    expect(split.offers).toEqual([{ connect_url: URL_ }]);

    const prose = "plain prose, no JSON";
    expect(splitJsonText(prose)).toEqual({ text: prose, offers: [] });
  });

  it("returns every offer a JSON block carries", () => {
    const json = JSON.stringify([{ auth_url: "https://a.example/one" }, { connect_url: URL_ }]);
    expect(splitJsonText(json).offers).toEqual([
      { connect_url: "https://a.example/one" },
      { connect_url: URL_ },
    ]);
  });
});

describe("mergeConnectOffers", () => {
  it("concatenates in order, keeping the first entry per URL", () => {
    expect(
      mergeConnectOffers(
        [{ connect_url: "https://a.example/one", state: "st-1" }],
        [{ connect_url: "https://a.example/one", state: "st-2" }, { connect_url: URL_ }],
      ),
    ).toEqual([{ connect_url: "https://a.example/one", state: "st-1" }, { connect_url: URL_ }]);
  });
});
