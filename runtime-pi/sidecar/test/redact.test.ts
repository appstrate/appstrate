// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { filterSensitiveHeaders, redactLocationHeader, scrubBearerMaterial } from "../redact.ts";

describe("filterSensitiveHeaders", () => {
  it("drops set-cookie from a Headers instance", () => {
    const h = new Headers();
    h.set("Content-Type", "application/json");
    h.set("Set-Cookie", "session=abc123; HttpOnly");
    const out = filterSensitiveHeaders(h);
    expect(out["content-type"] ?? out["Content-Type"]).toBe("application/json");
    expect(out["set-cookie"]).toBeUndefined();
    expect(out["Set-Cookie"]).toBeUndefined();
  });

  it("drops www-authenticate, proxy-authenticate, authorization, x-api-key, cookie", () => {
    const h: Record<string, string> = {
      "WWW-Authenticate": "Bearer realm=oauth",
      "Proxy-Authenticate": "Basic",
      Authorization: "Bearer leaked-token",
      "x-api-key": "sk-leaked",
      Cookie: "session=abc",
      "x-request-id": "req_keepme",
      "content-type": "application/json",
    };
    const out = filterSensitiveHeaders(h);
    expect(out["WWW-Authenticate"]).toBeUndefined();
    expect(out["Proxy-Authenticate"]).toBeUndefined();
    expect(out["Authorization"]).toBeUndefined();
    expect(out["x-api-key"]).toBeUndefined();
    expect(out["Cookie"]).toBeUndefined();
    expect(out["x-request-id"]).toBe("req_keepme");
    expect(out["content-type"]).toBe("application/json");
  });

  it("matches header names case-insensitively", () => {
    const h: Record<string, string> = {
      "SET-COOKIE": "x=1",
      "set-Cookie": "y=2",
      "X-API-Key": "leaked",
    };
    const out = filterSensitiveHeaders(h);
    expect(Object.keys(out)).toHaveLength(0);
  });

  it("preserves non-sensitive headers unchanged (RateLimit, retry-after, request-id)", () => {
    const h: Record<string, string> = {
      "RateLimit-Limit": "100",
      "RateLimit-Remaining": "0",
      "Retry-After": "30",
      "x-request-id": "req_xyz",
      "content-type": "application/json",
    };
    const out = filterSensitiveHeaders(h);
    expect(out).toEqual(h);
  });

  it("returns an empty object when all headers are sensitive", () => {
    const h: Record<string, string> = {
      "set-cookie": "x",
      authorization: "Bearer y",
    };
    expect(filterSensitiveHeaders(h)).toEqual({});
  });

  it("redacts Location to origin + path instead of dropping it (Headers instance)", () => {
    const h = new Headers();
    h.set("Location", "https://files.example.com/dl/report.pdf?X-Amz-Signature=SECRET&x=1");
    h.set("content-type", "text/html");
    const out = filterSensitiveHeaders(h);
    // Headers normalises names to lowercase.
    expect(out["location"]).toBe("https://files.example.com/dl/report.pdf");
    expect(out["content-type"]).toBe("text/html");
  });

  it("redacts Location case-insensitively on a plain record, preserving casing", () => {
    const h: Record<string, string> = {
      LOCATION: "https://sso.example.com/cb?access_token=tok_leak#frag",
    };
    const out = filterSensitiveHeaders(h);
    expect(out["LOCATION"]).toBe("https://sso.example.com/cb");
  });
});

describe("redactLocationHeader", () => {
  it("strips the query string from an absolute URL", () => {
    expect(redactLocationHeader("https://h.example/p/a?token=secret")).toBe(
      "https://h.example/p/a",
    );
  });

  it("keeps an absolute URL without query untouched (origin + path)", () => {
    expect(redactLocationHeader("https://h.example/p/a")).toBe("https://h.example/p/a");
  });

  it("strips userinfo from an absolute URL", () => {
    expect(redactLocationHeader("https://user:pass@h.example/p?q=1")).toBe("https://h.example/p");
  });

  it("preserves a non-default port (diagnostic) while stripping the query", () => {
    expect(redactLocationHeader("https://h.example:8443/p?sig=s")).toBe("https://h.example:8443/p");
  });

  it("strips the query from a relative Location and keeps the path", () => {
    expect(redactLocationHeader("/oauth/cb?code=abc&state=xyz")).toBe("/oauth/cb");
  });

  it("keeps a plain relative path as-is", () => {
    expect(redactLocationHeader("/next")).toBe("/next");
  });

  it("strips the fragment from a relative Location", () => {
    expect(redactLocationHeader("/page#access_token=tok")).toBe("/page");
  });

  it("strips userinfo and query from a scheme-relative Location", () => {
    expect(redactLocationHeader("//user:pass@h.example/p?sig=s")).toBe("//h.example/p");
  });
});

describe("scrubBearerMaterial", () => {
  it("masks an sk-ant token embedded in an error body", () => {
    expect(scrubBearerMaterial('{"error":"bad key sk-ant-oat01-abc-def"}')).toBe(
      '{"error":"bad key [redacted]"}',
    );
  });

  it("masks a Bearer sequence (echoed authorization material)", () => {
    expect(scrubBearerMaterial("upstream said: Bearer eyJhbGciOi.abc_def-ghi rejected")).toBe(
      "upstream said: [redacted] rejected",
    );
  });

  it("is case-insensitive and leaves clean text byte-identical", () => {
    expect(scrubBearerMaterial("bearer tok123 and SK-ANT-x1")).toBe("[redacted] and [redacted]");
    const clean = '{"error":{"type":"overloaded_error"}}';
    expect(scrubBearerMaterial(clean)).toBe(clean);
  });
});
