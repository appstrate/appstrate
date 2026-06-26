// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { extractAuthOffer } from "../src/ui/auth-offer.ts";

const BODY = { auth_url: "https://accounts.google.com/o/oauth2/v2/auth?x=1", state: "abc-123" };

describe("extractAuthOffer", () => {
  it("reads the AI SDK MCP content envelope ({type:'content',value:[{type:'text',text}]})", () => {
    // This is the exact shape @ai-sdk/mcp produces for a tool result.
    const result = {
      type: "content",
      value: [{ type: "text", text: JSON.stringify(BODY, null, 2) }],
    };
    expect(extractAuthOffer(result)).toEqual({ authUrl: BODY.auth_url, state: "abc-123" });
  });

  it("reads the raw MCP CallToolResult ({content:[{type:'text',text}]})", () => {
    const result = { content: [{ type: "text", text: JSON.stringify(BODY) }], isError: false };
    expect(extractAuthOffer(result)).toEqual({ authUrl: BODY.auth_url, state: "abc-123" });
  });

  it("reads the structured-content / json envelope ({type:'json',value:{...}})", () => {
    expect(extractAuthOffer({ type: "json", value: BODY })).toEqual({
      authUrl: BODY.auth_url,
      state: "abc-123",
    });
  });

  it("reads a direct body and camelCase keys", () => {
    expect(extractAuthOffer(BODY)).toEqual({ authUrl: BODY.auth_url, state: "abc-123" });
    expect(extractAuthOffer({ authUrl: "https://x/y", state: "s" })).toEqual({
      authUrl: "https://x/y",
      state: "s",
    });
  });

  it("parses a flattened JSON string result", () => {
    expect(extractAuthOffer(JSON.stringify(BODY))).toEqual({
      authUrl: BODY.auth_url,
      state: "abc-123",
    });
  });

  it("returns null when there is no auth_url (error result, plain text, nullish)", () => {
    expect(extractAuthOffer(null)).toBeNull();
    expect(extractAuthOffer("not json")).toBeNull();
    expect(extractAuthOffer({ content: [{ type: "text", text: "an error happened" }] })).toBeNull();
    expect(extractAuthOffer({ type: "content", value: [{ type: "text", text: "{}" }] })).toBeNull();
  });
});
