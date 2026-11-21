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
    const split = splitJsonText(json, splitConnectPayload);
    expect(split.text).not.toContain("token=SECRET");
    expect(split.offers).toEqual([{ connect_url: URL_ }]);

    const prose = "plain prose, no JSON";
    expect(splitJsonText(prose, splitConnectPayload)).toEqual({ text: prose, offers: [] });
  });

  it("returns every offer a JSON block carries", () => {
    const json = JSON.stringify([{ auth_url: "https://a.example/one" }, { connect_url: URL_ }]);
    expect(splitJsonText(json, splitConnectPayload).offers).toEqual([
      { connect_url: "https://a.example/one" },
      { connect_url: URL_ },
    ]);
  });
});

describe("offerScopeOf", () => {
  const STRANGER = "https://evil.example/login";
  const PLATFORM = "https://app.example/connect/abc";
  const PLATFORM_2 = "https://app.example/connect/def";
  const refusal = (connect_url: string) => ({ code: "needs_reconnection", connect_url });

  it("offers the link of an operation whose response is one, and only there", () => {
    for (const operation_id of ["initiateIntegrationConnect", "initiateIntegrationOAuth"]) {
      const split = offerScopeOf("invoke_operation", { arguments: { operation_id } })({
        status: 200,
        body: { connect_url: PLATFORM },
      });
      expect(split.offers).toEqual([{ connect_url: PLATFORM }]);
      expect(JSON.stringify(split.redacted)).not.toContain(PLATFORM);
    }
  });

  it("redacts, but never offers, a link in anything else, whoever wrote it", () => {
    // A run's result read back, a file, an unknown tool: the platform stores them, someone
    // else wrote them.
    const payload = { status: 200, body: { result: { connect_url: STRANGER } } };
    for (const [tool, args] of [
      ["invoke_operation", { operation_id: "getRun" }],
      ["invoke_operation", {}],
      ["read", {}],
    ] as const) {
      const split = offerScopeOf(tool, { arguments: args })(payload);
      expect(split.offers).toEqual([]);
      expect(JSON.stringify(split.redacted)).not.toContain(STRANGER);
    }
  });

  it("offers a run launch's readiness links, never a link in the run's result", () => {
    const scope = offerScopeOf("run_and_wait", {});
    const refused = scope({ status: 409, body: { errors: [refusal(PLATFORM)] } });
    expect(refused.offers).toEqual([{ connect_url: PLATFORM }]);
    const done = scope({ id: "run_1", status: "success", done: true, result: refusal(STRANGER) });
    expect(done.offers).toEqual([]);
    expect(JSON.stringify(done.redacted)).not.toContain(STRANGER);
  });

  it("passes a result the platform marked relayed on verbatim, with no card", () => {
    const upstream = { content: [{ type: "text", text: "x" }], connect_url: STRANGER };
    const scope = offerScopeOf("call_integration_tool", { relayed: true });
    expect(scope(upstream)).toEqual({ redacted: upstream, offers: [] });
    const text = JSON.stringify(upstream);
    expect(splitJsonText(text, scope)).toEqual({ text, offers: [] });
  });

  it("offers an integration call's own refusal, and an api_call batch's per-request refusals", () => {
    const scope = offerScopeOf("call_integration_tool", {});
    expect(scope(refusal(PLATFORM)).offers).toEqual([{ connect_url: PLATFORM }]);

    const batch = {
      session_id: "s",
      results: [
        { index: 0, error: refusal(PLATFORM) },
        // The upstream's answer: its body and headers are the stranger's.
        {
          index: 1,
          status: 200,
          headers: { connect_url: STRANGER },
          body: { connect_url: STRANGER, auth_url: STRANGER },
        },
      ],
    };
    const split = scope(batch);
    expect(split.offers).toEqual([{ connect_url: PLATFORM }]);
    const redacted = split.redacted as typeof batch;
    expect(redacted.results[0]!.error!.connect_url).toBe(REDACTED_CONNECT_LINK);
    expect(redacted.results[1]).toBe(batch.results[1]);
  });

  it("offers a search's refusals, never a server's descriptions or schemas", () => {
    const payload = {
      operations: { total: 0, items: [] },
      integration_tools: {
        total: 1,
        items: [{ id: "x__find", description: "find", connect_url: STRANGER }],
        not_ready: [{ integration_package_id: "@x/y", refusal: refusal(PLATFORM) }],
        unlisted: [{ integration_package_id: "@x/z", refusal: refusal(PLATFORM_2) }],
      },
    };
    const split = offerScopeOf("search", {})(payload);
    expect(split.offers).toEqual([{ connect_url: PLATFORM }, { connect_url: PLATFORM_2 }]);
    const redacted = split.redacted as typeof payload;
    expect(redacted.operations).toBe(payload.operations);
    expect(redacted.integration_tools.items).toBe(payload.integration_tools.items);
    expect(redacted.integration_tools.not_ready[0]!.refusal.connect_url).toBe(
      REDACTED_CONNECT_LINK,
    );
    expect(redacted.integration_tools.unlisted[0]!.refusal.connect_url).toBe(REDACTED_CONNECT_LINK);

    // The search refused outright: its whole answer is the platform's.
    expect(offerScopeOf("search", {})(refusal(PLATFORM)).offers).toEqual([
      { connect_url: PLATFORM },
    ]);
  });

  it("redacts, never offers, a link a member wrote into an agent or a skill a search lists", () => {
    const payload = {
      agents: { total: 1, items: [{ id: "@a/b", connect_url: STRANGER }] },
      skills: { total: 1, items: [{ id: "skill://x", connect_url: STRANGER }] },
    };
    const split = offerScopeOf("search", {})(payload);
    expect(split.offers).toEqual([]);
    expect(JSON.stringify(split.redacted)).not.toContain(STRANGER);
  });

  it("offers a describe refusal, and nothing of a described item, whatever its kind", () => {
    const scope = offerScopeOf("describe", {});
    expect(scope(refusal(PLATFORM)).offers).toEqual([{ connect_url: PLATFORM }]);
    // A route problem relayed for an agent that cannot be read.
    expect(scope({ status: 403, body: refusal(PLATFORM) }).offers).toEqual([
      { connect_url: PLATFORM },
    ]);

    const link = { connect_url: STRANGER };
    for (const described of [
      { kind: "operation", id: "getRun", responses: { 200: { example: link } } },
      { kind: "agent", id: "@a/b", input: link, run_with: { arguments: link } },
      { kind: "skill", id: "skill://x", frontmatter: link, resources: [link] },
      { kind: "integration_tool", id: "x__find", input_schema: { properties: { q: link } } },
    ]) {
      const split = scope(described);
      expect(split.offers).toEqual([]);
      expect(JSON.stringify(split.redacted)).not.toContain(STRANGER);
    }
  });

  it("leaves a search with nothing to redact untouched", () => {
    const payload = {
      operations: { total: 0, items: [] },
      integration_tools: { total: 0, items: [] },
    };
    const split = offerScopeOf("search", {})(payload);
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
