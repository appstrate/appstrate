// SPDX-License-Identifier: Apache-2.0

/**
 * Single-pass connect-offer split: redaction and extraction are the same walk,
 * so whatever leaves the payload surfaces as the typed offer — and ONLY there.
 * Regression coverage for issue #906 (the UI scraper used to pick the redaction
 * placeholder out of the model channel and render it as a relative URL).
 */

import { describe, expect, it } from "bun:test";
import {
  REDACTED_CONNECT_LINK,
  readConnectOffer,
  splitConnectPayload,
  splitJsonText,
  splitToolResult,
} from "../src/connect-offer.ts";
import { wrapToolConnectOffers } from "../src/platform-mcp.ts";

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

  it("returns the same reference and no offer when nothing matches", () => {
    const payload = { ok: true, nested: { a: [1, 2] } };
    const { redacted, offer } = splitConnectPayload(payload);
    expect(redacted).toBe(payload);
    expect(offer).toBeNull();
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

describe("splitToolResult", () => {
  it("splits an MCP CallToolResult and attaches the typed offer", () => {
    const result = {
      content: [
        { type: "text", text: JSON.stringify({ status: 200, body: { connect_url: URL_ } }) },
      ],
      isError: false,
    };
    const out = splitToolResult(result) as Record<string, unknown>;
    expect((out.content as Array<{ text: string }>)[0]!.text).not.toContain("token=SECRET");
    expect(out.connectOffer).toEqual({ connect_url: URL_ });
    expect(out.isError).toBe(false);
  });

  it("prefers the structuredContent offer and redacts it too", () => {
    const result = {
      content: [{ type: "text", text: JSON.stringify({ connect_url: "https://x/from-text" }) }],
      structuredContent: { connect_url: URL_ },
    };
    const out = splitToolResult(result) as { structuredContent: { connect_url: string } } & {
      connectOffer: unknown;
    };
    expect(out.structuredContent.connect_url).toBe(REDACTED_CONNECT_LINK);
    expect(out.connectOffer).toEqual({ connect_url: URL_ });
  });

  it("handles the AI SDK bridge envelopes ({type:'content'|'json'})", () => {
    const contentEnv = {
      type: "content",
      value: [{ type: "text", text: JSON.stringify({ auth_url: URL_, state: "s" }) }],
    };
    const outContent = splitToolResult(contentEnv) as Record<string, unknown>;
    expect(JSON.stringify(outContent.value)).not.toContain("token=SECRET");
    expect(outContent.connectOffer).toEqual({ connect_url: URL_, state: "s" });

    const jsonEnv = { type: "json", value: { connect_url: URL_ } };
    const outJson = splitToolResult(jsonEnv) as Record<string, unknown>;
    expect((outJson.value as { connect_url: string }).connect_url).toBe(REDACTED_CONNECT_LINK);
    expect(outJson.connectOffer).toEqual({ connect_url: URL_ });
  });

  it("returns the original reference for a result without connect links", () => {
    const result = { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
    expect(splitToolResult(result)).toBe(result);
  });
});

describe("readConnectOffer", () => {
  it("reads the typed field at the top level and one output level down", () => {
    const offer = { connect_url: URL_, state: "s" };
    expect(readConnectOffer({ content: [], connectOffer: offer })).toEqual(offer);
    expect(readConnectOffer({ output: { connectOffer: offer } })).toEqual(offer);
  });

  it("rejects malformed or placeholder-bearing offers", () => {
    expect(readConnectOffer({ connectOffer: { connect_url: REDACTED_CONNECT_LINK } })).toBeNull();
    expect(readConnectOffer({ connectOffer: { connect_url: 42 } })).toBeNull();
    expect(readConnectOffer({ connectOffer: "https://x/y" })).toBeNull();
    expect(readConnectOffer(null)).toBeNull();
  });
});

describe("wrapToolConnectOffers (ai-sdk execute wrapper)", () => {
  it("splits every tool's execute result and leaves execute-less tools untouched", async () => {
    const noExecute = { description: "schema only" };
    const withExecute = {
      description: "connect kickoff",
      execute: async () => ({
        content: [{ type: "text", text: JSON.stringify({ body: { connect_url: URL_ } }) }],
      }),
    };
    const wrapped = wrapToolConnectOffers({ noExecute, withExecute } as never) as unknown as {
      noExecute: unknown;
      withExecute: { execute: (a: unknown, o: unknown) => Promise<Record<string, unknown>> };
    };

    expect(wrapped.noExecute).toBe(noExecute as never);

    const out = await wrapped.withExecute.execute({}, {});
    expect(JSON.stringify(out.content)).not.toContain("token=SECRET");
    expect(out.connectOffer).toEqual({ connect_url: URL_ });
  });
});
