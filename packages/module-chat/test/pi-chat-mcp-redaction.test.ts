// SPDX-License-Identifier: Apache-2.0

/**
 * Connect-link handling on the Pi chat path — parity with the ai-sdk path's
 * `wrapToolConnectOffers`. The MODEL-visible channel of a Pi tool result is its
 * `content` text blocks (pi-ai serializes only `content` upstream) and must
 * have `connect_url`/`auth_url` scrubbed. The UI reads the typed `connectOffer`
 * field to render the connect card — the live URL exists nowhere else in the
 * persisted output (`details` is redacted too, issue #906).
 */

import { describe, expect, it } from "bun:test";
import { mcpResultToPi, toPiToolResult } from "../src/pi-chat/mcp-tools.ts";

const OFFER = {
  status: "auth_required",
  connect_url: "https://app.example.com/connect/start?token=SECRET",
  package_id: "@appstrate/gmail",
};

describe("toPiToolResult (run_and_wait payloads)", () => {
  it("redacts connect_url everywhere, surfaces it only through connectOffer", () => {
    const result = toPiToolResult(OFFER);
    const modelText = result.content[0]!.text;
    expect(modelText).not.toContain("token=SECRET");
    expect(modelText).toContain("connect link hidden");
    // The persisted payload channels carry the placeholder, never the URL.
    expect(JSON.stringify(result.details)).not.toContain("token=SECRET");
    // The typed offer is the single place the live URL survives.
    expect(result.connectOffer).toEqual({ connect_url: OFFER.connect_url });
  });

  it("leaves payloads without connect links byte-identical, with no offer", () => {
    const payload = { status: "success", output: { ok: true } };
    const result = toPiToolResult(payload);
    expect(result.content[0]!.text).toBe(JSON.stringify(payload));
    expect(result.details).toBe(payload);
    expect(result.connectOffer).toBeUndefined();
  });
});

describe("mcpResultToPi (forwarded MCP tool results)", () => {
  it("redacts connect links inside JSON text blocks and captures the typed offer", () => {
    const mcp = {
      content: [{ type: "text", text: JSON.stringify(OFFER) }],
    };
    const result = mcpResultToPi(mcp as never);
    expect(result.content[0]!.text).not.toContain("token=SECRET");
    expect(result.content[0]!.text).toContain("connect link hidden");
    // Details are redacted too — the URL lives only in the typed offer.
    expect(JSON.stringify(result.details)).not.toContain("token=SECRET");
    expect(result.connectOffer).toEqual({ connect_url: OFFER.connect_url });
  });

  it("also redacts the legacy auth_url field and keeps its state in the offer", () => {
    const mcp = {
      content: [
        {
          type: "text",
          text: JSON.stringify({ auth_url: "https://x/authorize?s=SECRET", state: "st-1" }),
        },
      ],
    };
    const result = mcpResultToPi(mcp as never);
    expect(result.content[0]!.text).not.toContain("s=SECRET");
    expect(result.connectOffer).toEqual({
      connect_url: "https://x/authorize?s=SECRET",
      state: "st-1",
    });
  });

  it("passes non-JSON text through byte-identical", () => {
    const mcp = { content: [{ type: "text", text: "plain prose, no JSON" }] };
    const result = mcpResultToPi(mcp as never);
    expect(result.content[0]!.text).toBe("plain prose, no JSON");
    expect(result.connectOffer).toBeUndefined();
  });

  it("prefers structuredContent for details (redacted) and for the offer", () => {
    const mcp = {
      content: [{ type: "text", text: JSON.stringify(OFFER) }],
      structuredContent: OFFER,
    };
    const result = mcpResultToPi(mcp as never);
    expect(result.details).toEqual({ ...OFFER, connect_url: expect.stringContaining("hidden") });
    expect(JSON.stringify(result.details)).not.toContain("token=SECRET");
    expect(result.connectOffer).toEqual({ connect_url: OFFER.connect_url });
  });
});
