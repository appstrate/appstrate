// SPDX-License-Identifier: Apache-2.0

/**
 * Connect-link redaction on the Pi chat path — parity with the ai-sdk path's
 * `wrapToolModelOutputs`. The MODEL-visible channel of a Pi tool result is its
 * `content` text blocks (pi-ai serializes only `content` upstream); the UI
 * reads the full tool output (including `details`) to render the connect card.
 * So: `content` must have `connect_url`/`auth_url` scrubbed, `details` must
 * keep the original payload intact.
 */

import { describe, expect, it } from "bun:test";
import { mcpResultToPi, toPiToolResult } from "../src/pi-chat/mcp-tools.ts";

const OFFER = {
  status: "auth_required",
  connect_url: "https://app.example.com/connect/start?token=SECRET",
  package_id: "@appstrate/gmail",
};

describe("toPiToolResult (run_and_wait payloads)", () => {
  it("redacts connect_url from the model-visible text, keeps details intact", () => {
    const result = toPiToolResult(OFFER);
    const modelText = result.content[0]!.text;
    expect(modelText).not.toContain("token=SECRET");
    expect(modelText).toContain("connect link hidden");
    expect(result.details).toEqual(OFFER);
  });

  it("leaves payloads without connect links byte-identical", () => {
    const payload = { status: "success", output: { ok: true } };
    const result = toPiToolResult(payload);
    expect(result.content[0]!.text).toBe(JSON.stringify(payload));
    expect(result.details).toBe(payload);
  });
});

describe("mcpResultToPi (forwarded MCP tool results)", () => {
  it("redacts connect links inside JSON text blocks, preserves the full result in details", () => {
    const mcp = {
      content: [{ type: "text", text: JSON.stringify(OFFER) }],
    };
    const result = mcpResultToPi(mcp as never);
    expect(result.content[0]!.text).not.toContain("token=SECRET");
    expect(result.content[0]!.text).toContain("connect link hidden");
    // UI channel: the original result (with the live URL) survives untouched.
    expect(JSON.stringify(result.details)).toContain("token=SECRET");
  });

  it("also redacts the legacy auth_url field", () => {
    const mcp = {
      content: [
        { type: "text", text: JSON.stringify({ auth_url: "https://x/authorize?s=SECRET" }) },
      ],
    };
    const result = mcpResultToPi(mcp as never);
    expect(result.content[0]!.text).not.toContain("s=SECRET");
  });

  it("passes non-JSON text through byte-identical", () => {
    const mcp = { content: [{ type: "text", text: "plain prose, no JSON" }] };
    const result = mcpResultToPi(mcp as never);
    expect(result.content[0]!.text).toBe("plain prose, no JSON");
  });

  it("prefers structuredContent for details when present", () => {
    const mcp = {
      content: [{ type: "text", text: JSON.stringify(OFFER) }],
      structuredContent: OFFER,
    };
    const result = mcpResultToPi(mcp as never);
    expect(result.details).toBe(OFFER);
  });
});
