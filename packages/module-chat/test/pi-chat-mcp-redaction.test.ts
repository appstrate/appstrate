// SPDX-License-Identifier: Apache-2.0

/**
 * Connect-link handling on the model-visible channel of a Pi tool result —
 * The MODEL-visible channel of a Pi tool result is its
 * `content` text blocks (pi-ai serializes only `content` upstream) and must
 * have `connect_url`/`auth_url` scrubbed. The UI reads the typed `connectOffers`
 * field to render one connect card per link — the live URLs exist nowhere else
 * in the persisted output (`details` is redacted too, issue #906).
 */

import { describe, expect, it } from "bun:test";
import { mcpResultToPi, toPiToolResult } from "../src/pi-chat/mcp-tools.ts";

const OFFER = {
  status: "auth_required",
  connect_url: "https://app.example.com/connect/start?token=SECRET",
  package_id: "@appstrate/gmail",
};

describe("toPiToolResult (run_and_wait payloads)", () => {
  it("redacts connect_url everywhere, surfaces it only through connectOffers", () => {
    const result = toPiToolResult(OFFER);
    const modelText = result.content[0]!.text;
    expect(modelText).not.toContain("token=SECRET");
    expect(modelText).toContain("connect link hidden");
    // The persisted payload channels carry the placeholder, never the URL.
    expect(JSON.stringify(result.details)).not.toContain("token=SECRET");
    // The typed offers are the single place the live URL survives.
    expect(result.connectOffers).toEqual([
      { connect_url: OFFER.connect_url, package_id: OFFER.package_id },
    ]);
  });

  it("leaves payloads without connect links byte-identical, with no offers", () => {
    const payload = { status: "success", output: { ok: true } };
    const result = toPiToolResult(payload);
    expect(result.content[0]!.text).toBe(JSON.stringify(payload));
    expect(result.details).toBe(payload);
    // Absent, not an empty array: an offer-less payload stays byte-identical.
    expect("connectOffers" in result).toBe(false);
  });

  // Issue #1207 phase 5: the readiness preflight mints the link itself, so the
  // chat's `run_and_wait` failure step IS the connect card's data source — one
  // offer per actionable integration, `expires_at` and `package_id` included,
  // and not a byte of any link on the model channel.
  it("splits a 412 launch failure into a fully redacted step and one offer per item", () => {
    const result = toPiToolResult({
      status: 412,
      body: {
        code: "missing_integration_connection",
        errors: [
          {
            field: "integrations.@appstrate/gmail",
            code: "not_connected",
            message: "not connected",
            auth_key: "primary",
            required_scopes: ["mail.read"],
            connect_url: "https://app.example.com/api/integrations/connect/start?token=AAA",
            expires_at: 1_900_000_000_000,
            package_id: "@appstrate/gmail",
          },
          {
            field: "integrations.@appstrate/clickup",
            code: "insufficient_scopes",
            message: "missing scopes",
            auth_key: "primary",
            connection_id: "conn-9",
            owned_by_actor: true,
            connect_url: "https://app.example.com/api/integrations/connect/start?token=BBB",
            expires_at: 1_900_000_001_000,
            package_id: "@appstrate/clickup",
          },
        ],
      },
    });

    expect(result.connectOffers).toEqual([
      {
        connect_url: "https://app.example.com/api/integrations/connect/start?token=AAA",
        expires_at: 1_900_000_000_000,
        package_id: "@appstrate/gmail",
      },
      {
        connect_url: "https://app.example.com/api/integrations/connect/start?token=BBB",
        expires_at: 1_900_000_001_000,
        package_id: "@appstrate/clickup",
      },
    ]);
    // Both tokens are gone from every model-visible channel — the whole point
    // of minting server-side is that the model never has to handle the link.
    const modelText = result.content[0]!.text;
    for (const token of ["token=AAA", "token=BBB"]) {
      expect(modelText).not.toContain(token);
      expect(JSON.stringify(result.details)).not.toContain(token);
    }
    // The rest of the 412 survives intact: the model still explains WHY.
    expect(modelText).toContain("missing_integration_connection");
    expect(modelText).toContain("integrations.@appstrate/gmail");
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
    // Details are redacted too — the URL lives only in the typed offers.
    expect(JSON.stringify(result.details)).not.toContain("token=SECRET");
    expect(result.connectOffers).toEqual([
      { connect_url: OFFER.connect_url, package_id: OFFER.package_id },
    ]);
  });

  it("merges the offers of every text block, deduping a repeated link", () => {
    const mcp = {
      content: [
        { type: "text", text: JSON.stringify({ connect_url: "https://app.example.com/c/1?t=A" }) },
        {
          type: "text",
          text: JSON.stringify([
            { connect_url: "https://app.example.com/c/1?t=A" },
            { connect_url: "https://app.example.com/c/2?t=B" },
          ]),
        },
      ],
    };
    const result = mcpResultToPi(mcp as never);
    expect(result.connectOffers).toEqual([
      { connect_url: "https://app.example.com/c/1?t=A" },
      { connect_url: "https://app.example.com/c/2?t=B" },
    ]);
    expect(JSON.stringify(result.content)).not.toContain("t=A");
    expect(JSON.stringify(result.content)).not.toContain("t=B");
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
    expect(result.connectOffers).toEqual([
      { connect_url: "https://x/authorize?s=SECRET", state: "st-1" },
    ]);
  });

  it("passes non-JSON text through byte-identical", () => {
    const mcp = { content: [{ type: "text", text: "plain prose, no JSON" }] };
    const result = mcpResultToPi(mcp as never);
    expect(result.content[0]!.text).toBe("plain prose, no JSON");
    expect("connectOffers" in result).toBe(false);
  });

  it("prefers structuredContent for details (redacted) and for the offers", () => {
    const mcp = {
      content: [{ type: "text", text: JSON.stringify(OFFER) }],
      structuredContent: OFFER,
    };
    const result = mcpResultToPi(mcp as never);
    expect(result.details).toEqual({ ...OFFER, connect_url: expect.stringContaining("hidden") });
    expect(JSON.stringify(result.details)).not.toContain("token=SECRET");
    expect(result.connectOffers).toEqual([
      { connect_url: OFFER.connect_url, package_id: OFFER.package_id },
    ]);
  });

  // structuredContent is canonical: its offers REPLACE the text-derived ones
  // rather than merging, so a text block that renders only part of the payload
  // cannot smuggle a stale link past the canonical list.
  it("lets structuredContent offers replace the text-block offers wholesale", () => {
    const mcp = {
      content: [{ type: "text", text: JSON.stringify({ connect_url: "https://stale/one?t=A" }) }],
      structuredContent: {
        integrations: [
          { connect_url: "https://app.example.com/c/1?t=B" },
          { connect_url: "https://app.example.com/c/2?t=C" },
        ],
      },
    };
    const result = mcpResultToPi(mcp as never);
    expect(result.connectOffers).toEqual([
      { connect_url: "https://app.example.com/c/1?t=B" },
      { connect_url: "https://app.example.com/c/2?t=C" },
    ]);
  });
});
