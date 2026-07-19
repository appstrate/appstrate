// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";

import {
  buildLeboncoinCookieHeader,
  detectDataDomeChallenge,
  detectRejectedCredentials,
  handleRequest,
  hasLeboncoinSession,
  normalizeListingUrl,
} from "../../../../scripts/system-packages/mcp-server-leboncoin-browser-1.0.0/server/index.ts";

describe("Leboncoin browser driver safety helpers", () => {
  it("accepts only canonical www.leboncoin.fr listing URLs", () => {
    expect(normalizeListingUrl("https://www.leboncoin.fr/ad/velos/123#photos")).toBe(
      "https://www.leboncoin.fr/ad/velos/123",
    );
    expect(() => normalizeListingUrl("https://api.leboncoin.fr/ad/velos/123")).toThrow(
      /www\.leboncoin\.fr/,
    );
    expect(() => normalizeListingUrl("https://www.leboncoin.fr.evil.example/ad/velos/123")).toThrow(
      /www\.leboncoin\.fr/,
    );
    expect(() => normalizeListingUrl("https://www.leboncoin.fr/recherche?text=velo")).toThrow(
      /\/ad\//,
    );
  });

  it("exports only bounded Leboncoin-domain cookies and deduplicates names", () => {
    const cookies = [
      { name: "datadome", value: "domain", domain: ".leboncoin.fr", path: "/" },
      { name: "datadome", value: "www", domain: "www.leboncoin.fr", path: "/" },
      { name: "__Secure-login", value: "session", domain: "auth.leboncoin.fr", path: "/" },
      { name: "foreign", value: "secret", domain: ".example.com", path: "/" },
      { name: "bad", value: "x; injected=y", domain: ".leboncoin.fr", path: "/" },
    ];
    expect(buildLeboncoinCookieHeader(cookies)).toBe("__Secure-login=session; datadome=www");
    expect(hasLeboncoinSession(cookies)).toBe(true);
    expect(hasLeboncoinSession(cookies.slice(0, 2))).toBe(false);
  });

  it("recognizes DataDome surfaces without treating ordinary pages as challenges", () => {
    expect(
      detectDataDomeChallenge({
        url: "https://www.leboncoin.fr/recherche?text=velo",
        title: "leboncoin.fr",
        bodyText: "Pardon the interruption",
        frameUrls: ["https://geo.captcha-delivery.com/captcha/?cid=x"],
      }),
    ).toBe(true);
    expect(
      detectDataDomeChallenge({
        url: "https://www.leboncoin.fr/recherche?text=velo",
        title: "Annonces vélo d'occasion",
        bodyText: "Vélos d'occasion partout en France",
        frameUrls: ["https://geo.captcha-delivery.com.evil.example/captcha/"],
      }),
    ).toBe(false);
  });

  it("recognizes explicit credential rejection copy", () => {
    expect(detectRejectedCredentials("Adresse email ou mot de passe incorrect")).toBe(true);
    expect(detectRejectedCredentials("Connectez-vous à votre compte")).toBe(false);
  });
});

describe("Leboncoin browser MCP surface", () => {
  it("initializes and lists the manifest-declared tools", async () => {
    const initialized = await handleRequest({ jsonrpc: "2.0", id: 1, method: "initialize" });
    expect((initialized?.result as { protocolVersion: string }).protocolVersion).toBe("2024-11-05");

    const listed = await handleRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const tools = (listed?.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      ["acquire_session", "get_listing", "search_listings", "session_status"].sort(),
    );
  });

  it("validates public tool arguments before touching the browser", async () => {
    const search = await handleRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "search_listings", arguments: { query: "", limit: 500 } },
    });
    expect(search?.error?.code).toBe(-32602);

    const listing = await handleRequest({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "get_listing",
        arguments: { url: "https://evil.example/ad/123" },
      },
    });
    expect(listing?.error?.code).toBe(-32602);
  });

  it("rejects malformed private acquisition envelopes before browser access", async () => {
    const response = await handleRequest({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "acquire_session",
        arguments: {
          browser_endpoint: "http://browser:8080",
          browser_token: "short",
          inputs: { email: "user@example.com", password: "secret" },
          allowed_origins: ["https://www.leboncoin.fr", "https://auth.leboncoin.fr"],
          session_mode: "exportable",
        },
      },
    });
    expect(response?.error?.code).toBe(-32602);
    expect(response?.error?.message).toMatch(/browser_token/);
  });
});
