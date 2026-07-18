// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  extractAuthOffer,
  encodeResume,
  parseResume,
  INTEGRATION_RESUME_MARKER,
} from "../src/ui/auth-offer.ts";

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

  it("reads the unified connect_url offer (issue #769)", () => {
    // initiateIntegrationConnect returns { connect_url, expires_at } — no state.
    expect(
      extractAuthOffer({ connect_url: "https://app/api/integrations/connect/start?token=t" }),
    ).toEqual({ authUrl: "https://app/api/integrations/connect/start?token=t", state: undefined });
    expect(
      extractAuthOffer({
        content: [{ type: "text", text: JSON.stringify({ connect_url: "https://x/c" }) }],
      }),
    ).toEqual({ authUrl: "https://x/c", state: undefined });
  });

  it("reads a direct body and camelCase keys", () => {
    expect(extractAuthOffer(BODY)).toEqual({ authUrl: BODY.auth_url, state: "abc-123" });
    expect(extractAuthOffer({ authUrl: "https://x/y", state: "s" })).toEqual({
      authUrl: "https://x/y",
      state: "s",
    });
  });

  it("reads a bare content array", () => {
    expect(extractAuthOffer([{ type: "text", text: JSON.stringify(BODY) }])).toEqual({
      authUrl: BODY.auth_url,
      state: "abc-123",
    });
  });

  it("reads a deeply nested envelope ({output:{type:'content',value:[{text}]}})", () => {
    const result = {
      output: { type: "content", value: [{ type: "text", text: JSON.stringify(BODY) }] },
    };
    expect(extractAuthOffer(result)).toEqual({ authUrl: BODY.auth_url, state: "abc-123" });
  });

  it("parses a flattened JSON string result", () => {
    expect(extractAuthOffer(JSON.stringify(BODY))).toEqual({
      authUrl: BODY.auth_url,
      state: "abc-123",
    });
  });

  it("encodes/parses a resume message round-trip (meta + human text)", () => {
    const meta = { packageId: "@appstrate/gmail", name: "Gmail", icon: "logos:google-gmail" };
    const text = encodeResume(meta, "L'intégration Gmail est connectée. Continue.");
    expect(text.startsWith(INTEGRATION_RESUME_MARKER)).toBe(true);
    expect(text).toContain("Continue.");
    expect(parseResume(text)).toEqual(meta);
  });

  it("parseResume returns null for a normal user message", () => {
    expect(parseResume("récupère mes 3 derniers mails")).toBeNull();
  });

  it("parseResume tolerates a marker without a meta payload", () => {
    expect(parseResume(`${INTEGRATION_RESUME_MARKER}bare notice`)).toEqual({ packageId: "" });
  });

  it("returns null when there is no auth_url (error result, plain text, nullish)", () => {
    expect(extractAuthOffer(null)).toBeNull();
    expect(extractAuthOffer("not json")).toBeNull();
    expect(extractAuthOffer({ content: [{ type: "text", text: "an error happened" }] })).toBeNull();
    expect(extractAuthOffer({ type: "content", value: [{ type: "text", text: "{}" }] })).toBeNull();
  });

  it("prefers the typed connectOffer channel over anything in the payload", () => {
    const result = {
      content: [{ type: "text", text: JSON.stringify({ connect_url: "https://stale/other" }) }],
      connectOffer: { connect_url: "https://app/connect/start?token=t", state: "st" },
    };
    expect(extractAuthOffer(result)).toEqual({
      authUrl: "https://app/connect/start?token=t",
      state: "st",
    });
  });

  it("never renders the redaction placeholder as a URL (issue #906)", () => {
    // Exact persisted shape from the bug report: the model channel (`content`)
    // carries the placeholder, the legacy UI channel (`details`) the real URL.
    const placeholder = "[connect link hidden — the chat renders the connect card]";
    const stored = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: 200,
            body: { connect_url: placeholder, expires_at: 1784142529000 },
          }),
        },
      ],
      details: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: 200,
              body: {
                connect_url: "http://localhost:3001/api/integrations/connect/start?token=eyJREAL",
                expires_at: 1784142529000,
              },
            }),
          },
        ],
        isError: false,
      },
    };
    expect(extractAuthOffer(stored)).toEqual({
      authUrl: "http://localhost:3001/api/integrations/connect/start?token=eyJREAL",
      state: undefined,
    });
  });

  it("rejects a relative or non-http string under a connect key (legacy walk)", () => {
    expect(extractAuthOffer({ connect_url: "/api/integrations/connect/start" })).toBeNull();
    expect(extractAuthOffer({ auth_url: "javascript:alert(1)" })).toBeNull();
  });
});
