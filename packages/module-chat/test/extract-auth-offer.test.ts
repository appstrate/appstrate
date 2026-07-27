// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  extractAuthOffer,
  encodeResume,
  parseResume,
  INTEGRATION_RESUME_MARKER,
} from "../src/ui/auth-offer.ts";

const BODY = { auth_url: "https://accounts.google.com/o/oauth2/v2/auth?x=1", state: "abc-123" };
const OFFER = { connect_url: "https://app/api/integrations/connect/start?token=t" };

describe("extractAuthOffer", () => {
  it("reads the typed connectOffer at the top level and one output level down", () => {
    expect(extractAuthOffer({ content: [], connectOffer: { ...OFFER, state: "st" } })).toEqual({
      authUrl: OFFER.connect_url,
      state: "st",
    });
    // initiateIntegrationConnect returns { connect_url, expires_at } — no state.
    expect(
      extractAuthOffer({ output: { connectOffer: { ...OFFER, expires_at: 1784142529000 } } }),
    ).toEqual({ authUrl: OFFER.connect_url });
  });

  it("never renders a relative or non-http offer as a URL (issue #906)", () => {
    expect(
      extractAuthOffer({ connectOffer: { connect_url: "/api/integrations/connect/start" } }),
    ).toBeNull();
    expect(extractAuthOffer({ connectOffer: { connect_url: "javascript:alert(1)" } })).toBeNull();
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

  it("returns null for nullish, plain-text and offer-less results", () => {
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

  it("never scrapes a URL out of the payload — the typed field is the only channel", () => {
    // Every envelope a tool result can arrive in, each carrying a raw URL where
    // the pre-`connectOffer` deep-walk used to find one. All must yield nothing:
    // such a result predates the typed field by more than the connect session's
    // 10-minute TTL, so the URL it carries is dead (single-use token, expired).
    // The persisted `details` shape below is the exact issue-#906 report, whose
    // model channel (`content`) only ever holds the redaction placeholder.
    const placeholder = "[connect link hidden — the chat renders the connect card]";
    const legacyShapes: [name: string, shape: unknown][] = [
      [
        "ai-sdk content envelope",
        { type: "content", value: [{ type: "text", text: JSON.stringify(BODY) }] },
      ],
      [
        "raw CallToolResult",
        { content: [{ type: "text", text: JSON.stringify(BODY) }], isError: false },
      ],
      ["json envelope", { type: "json", value: BODY }],
      ["direct body", BODY],
      ["camelCase keys", { authUrl: "https://x/y", state: "s" }],
      ["top-level connect_url", { connect_url: OFFER.connect_url }],
      ["bare content array", [{ type: "text", text: JSON.stringify(BODY) }]],
      [
        "nested output envelope",
        { output: { type: "content", value: [{ type: "text", text: JSON.stringify(BODY) }] } },
      ],
      ["flat JSON string", JSON.stringify(BODY)],
      [
        "persisted details (issue #906)",
        {
          content: [{ type: "text", text: JSON.stringify({ body: { connect_url: placeholder } }) }],
          details: {
            content: [
              { type: "text", text: JSON.stringify({ body: { connect_url: "https://r" } }) },
            ],
          },
        },
      ],
    ];
    for (const [name, shape] of legacyShapes) {
      expect(extractAuthOffer(shape), `scraped a URL out of: ${name}`).toBeNull();
    }
  });
});
