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
  offerScopeOf,
  REDACTED_CONNECT_LINK,
  splitConnectPayload,
  splitJsonText,
} from "../src/connect-offer.ts";

const URL_ = "https://app.example.com/api/integrations/connect/start?token=SECRET";

describe("splitConnectPayload", () => {
  it("redacts and captures in one pass, with sibling state/expiresAt", () => {
    const payload = {
      status: 200,
      body: { connect_url: URL_, state: "st-1", expiresAt: "2026-07-15T19:08:49.000Z" },
    };
    const { redacted, offers } = splitConnectPayload(payload);
    expect(JSON.stringify(redacted)).not.toContain("token=SECRET");
    expect((redacted as { body: { connect_url: string } }).body.connect_url).toBe(
      REDACTED_CONNECT_LINK,
    );
    expect(offers).toEqual([
      { connect_url: URL_, state: "st-1", expiresAt: "2026-07-15T19:08:49.000Z" },
    ]);
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
  // `expiresAt` beside them). This fails the moment anyone reinstates an
  // `obj.expiresAt ?? obj.expires_at` fallback or a `connectUrl` key: the
  // twin would start being redacted and captured, and neither expectation here
  // would hold.
  it("reads the wire spelling only — a casing twin is neither redacted nor offered", () => {
    const payload = { connectUrl: URL_, connect_url: URL_, expires_at: "2026-07-15T19:08:49.000Z" };
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
      second: { auth_url: "https://a.example/two", expiresAt: "2026-07-15T19:08:49.000Z" },
    };
    const { redacted, offers } = splitConnectPayload(payload);
    expect(offers).toEqual([
      { connect_url: "https://a.example/one", state: "st-1" },
      { connect_url: "https://a.example/two", expiresAt: "2026-07-15T19:08:49.000Z" },
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

describe("offerScopeOf", () => {
  const STRANGER = "https://evil.example/login";
  const PLATFORM = "https://app.example/connect/abc";

  it("walks a platform tool's whole payload", () => {
    const split = offerScopeOf("invoke_operation")({ data: { connect_url: PLATFORM } });
    expect(split.offers).toEqual([{ connect_url: PLATFORM }]);
    expect((split.redacted as { data: { connect_url: string } }).data.connect_url).toBe(
      REDACTED_CONNECT_LINK,
    );
  });

  it("never builds a card from an integration tool's relayed result, and passes it on verbatim", () => {
    // An upstream API answering with a `connect_url` of its own.
    const upstream = { body: { connect_url: STRANGER, auth_url: STRANGER } };
    const split = offerScopeOf("call_integration_tool")(upstream);
    expect(split.offers).toEqual([]);
    expect(split.redacted).toBe(upstream);
    const text = JSON.stringify(upstream);
    expect(splitJsonText(text, offerScopeOf("call_integration_tool"))).toEqual({
      text,
      offers: [],
    });
  });

  it("takes a search's offers from its `not_ready` refusals alone, never from a server's schema", () => {
    const payload = {
      tools: [{ tool: "x__find", description: "find" }],
      best_match: {
        tool: "x__find",
        // A remote server controls its schemas.
        input_schema: { type: "object", properties: { q: { connect_url: STRANGER } } },
      },
      not_ready: [
        {
          integration_package_id: "@x/y",
          refusal: { code: "not_connected", connect_url: PLATFORM },
        },
      ],
    };
    const split = offerScopeOf("search_integration_tools")(payload);
    expect(split.offers).toEqual([{ connect_url: PLATFORM }]);
    const redacted = split.redacted as typeof payload;
    expect(redacted.best_match).toBe(payload.best_match);
    expect(redacted.not_ready[0]!.refusal.connect_url).toBe(REDACTED_CONNECT_LINK);
  });

  it("leaves a search without `not_ready` untouched", () => {
    const payload = { tools: [], best_match: { input_schema: { connect_url: STRANGER } } };
    const split = offerScopeOf("search_integration_tools")(payload);
    expect(split).toEqual({ redacted: payload, offers: [] });
    expect(split.redacted).toBe(payload);
  });
});

describe("mergeConnectOffers", () => {
  it("concatenates in order, keeping the first entry per URL", () => {
    expect(
      mergeConnectOffers([
        [{ connect_url: "https://a.example/one", state: "st-1" }],
        [{ connect_url: "https://a.example/one", state: "st-2" }, { connect_url: URL_ }],
      ]),
    ).toEqual([{ connect_url: "https://a.example/one", state: "st-1" }, { connect_url: URL_ }]);
  });
});
