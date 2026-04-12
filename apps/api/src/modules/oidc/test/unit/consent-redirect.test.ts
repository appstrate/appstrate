// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the consent JSON→302 helper introduced to fix the bug
 * where browser form POSTs to `/api/oauth/consent` rendered Better
 * Auth's `{redirect:true,url:"..."}` JSON body as the document instead of
 * following a real redirect.
 */

import { describe, it, expect } from "bun:test";
import { prefersHtml, maybeJsonRedirectToLocation } from "../../routes.ts";

describe("prefersHtml", () => {
  it("returns true for standard browser Accept headers", () => {
    expect(prefersHtml("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")).toBe(
      true,
    );
  });

  it("returns true for bare */*", () => {
    expect(prefersHtml("*/*")).toBe(true);
  });

  it("returns false for application/json", () => {
    expect(prefersHtml("application/json")).toBe(false);
  });

  it("returns false when JSON is mentioned even with HTML fallback", () => {
    // Programmatic callers that opt into JSON explicitly must always see
    // the verbatim plugin response — do not upgrade to a redirect.
    expect(prefersHtml("application/json, text/html")).toBe(false);
  });

  it("returns false for missing / empty header", () => {
    expect(prefersHtml(undefined)).toBe(false);
    expect(prefersHtml(null)).toBe(false);
    expect(prefersHtml("")).toBe(false);
  });
});

describe("maybeJsonRedirectToLocation", () => {
  it("converts a JSON {redirect:true,url} body to a 302 when acceptsHtml", async () => {
    const jsonResp = new Response(
      JSON.stringify({
        redirect: true,
        url: "https://satellite.example.com/callback?code=abc&state=xyz",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    const out = await maybeJsonRedirectToLocation(jsonResp, true);
    expect(out.status).toBe(302);
    expect(out.headers.get("location")).toBe(
      "https://satellite.example.com/callback?code=abc&state=xyz",
    );
  });

  it("preserves Set-Cookie headers from the plugin response", async () => {
    const jsonResp = new Response(JSON.stringify({ url: "https://a.example.com/cb" }), {
      status: 200,
      headers: new Headers([
        ["content-type", "application/json"],
        ["set-cookie", "better-auth.session_token=xyz; Path=/; HttpOnly"],
      ]),
    });
    const out = await maybeJsonRedirectToLocation(jsonResp, true);
    expect(out.status).toBe(302);
    expect(out.headers.get("set-cookie")).toContain("better-auth.session_token=xyz");
  });

  it("passes a verbatim 302 response through untouched", async () => {
    const already302 = new Response(null, {
      status: 302,
      headers: { location: "https://a.example.com/cb?code=3" },
    });
    const out = await maybeJsonRedirectToLocation(already302, true);
    expect(out).toBe(already302);
  });

  it("passes JSON through verbatim when acceptsHtml is false (API clients)", async () => {
    const jsonResp = new Response(
      JSON.stringify({ redirect: true, url: "https://a.example.com/cb" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    const out = await maybeJsonRedirectToLocation(jsonResp, false);
    expect(out).toBe(jsonResp);
  });

  it("passes non-JSON responses through untouched", async () => {
    const htmlResp = new Response("<html>oops</html>", {
      status: 500,
      headers: { "content-type": "text/html" },
    });
    const out = await maybeJsonRedirectToLocation(htmlResp, true);
    expect(out).toBe(htmlResp);
  });

  it("passes JSON bodies that are not redirect envelopes through untouched", async () => {
    const jsonResp = new Response(JSON.stringify({ error: "invalid_request" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
    const out = await maybeJsonRedirectToLocation(jsonResp, true);
    expect(out).toBe(jsonResp);
  });
});
