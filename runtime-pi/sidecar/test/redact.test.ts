// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { filterSensitiveHeaders, redactLocationHeader, scrubSecretMaterial } from "../redact.ts";

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

describe("scrubSecretMaterial", () => {
  it("masks an sk-ant token embedded in an error body", () => {
    expect(scrubSecretMaterial('{"error":"bad key sk-ant-oat01-abc-def"}')).toBe(
      '{"error":"bad key [redacted-key]"}',
    );
  });

  it("masks a Bearer sequence, keeping the scheme so the log stays readable", () => {
    expect(scrubSecretMaterial("upstream said: Bearer eyJhbGciOi.abc_def-ghi rejected")).toBe(
      "upstream said: Bearer [redacted] rejected",
    );
  });

  it("is case-insensitive on sk-ant and leaves clean text byte-identical", () => {
    expect(scrubSecretMaterial("bearer tok123 and SK-ANT-x1")).toBe(
      "bearer [redacted] and [redacted-key]",
    );
    const clean = '{"error":{"type":"overloaded_error"}}';
    expect(scrubSecretMaterial(clean)).toBe(clean);
  });

  // The reason this function replaced `scrubBearerMaterial`: each shape below
  // reached an operator log unmasked on the `/llm` path while the identical
  // shape was masked on the runner-stderr path, because two scrubbers of
  // unequal strength lived in the same process.
  it("masks the shapes the previous /llm scrubber let through", () => {
    expect(scrubSecretMaterial("key ghp_ABCdef123456789")).toBe("key [redacted-key]");
    expect(scrubSecretMaterial("aws key AKIAIOSFODNN7EXAMPLE")).toBe("aws key [redacted-key]");
    expect(scrubSecretMaterial("got ya29.a0AfH6SMBx-abc_123")).toBe("got [redacted-key]");
    expect(scrubSecretMaterial("used Basic aWQ6c2VjcmV0")).toBe("used Basic [redacted]");
    expect(scrubSecretMaterial("raw eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9")).toBe(
      "raw [redacted-jwt]",
    );
  });

  // Regression: the first version of this function put `\b` on the
  // `Bearer|Basic` and `sk-ant-` rules. In a percent-encoded URL the `0` of
  // `%20` sits immediately before the literal, so the anchor never matched and
  // the key shipped verbatim to the operator log — a LEAK the predecessor
  // (unanchored) did not have. These are the exact shapes upstream error
  // bodies and redirect targets carry.
  it("masks credentials that are not preceded by a word boundary", () => {
    const key = "sk-ant-api03-9fK2mQzXbT4LpR7wV";
    expect(
      scrubSecretMaterial(`https://api.x/v1?h=Authorization%3A%20Bearer%20${key}`),
    ).not.toContain(key);
    expect(scrubSecretMaterial(`/cb#Bearer%20${key}`)).not.toContain(key);
    expect(scrubSecretMaterial(`a${key}`)).not.toContain(key);
    expect(scrubSecretMaterial("_Bearer tokABC123xyz")).not.toContain("tokABC123xyz");
  });

  it("leaves prose that merely starts with a key prefix alone", () => {
    expect(scrubSecretMaterial("found skeletons in pkgroots directory")).toBe(
      "found skeletons in pkgroots directory",
    );
  });
});
