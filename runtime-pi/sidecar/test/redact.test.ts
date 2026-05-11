// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { redactSecrets, filterSensitiveHeaders } from "../redact.ts";

describe("redactSecrets", () => {
  it("redacts a JWT triple-segment token", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const out = redactSecrets(`token=${jwt} trailing`);
    expect(out).toBe("token=***JWT-REDACTED*** trailing");
    expect(out).not.toContain("eyJ");
  });

  it("redacts a Bearer header value", () => {
    const out = redactSecrets("Authorization: Bearer abc123XYZ-_.~+/==");
    expect(out).toBe("Authorization: Bearer ***REDACTED***");
    expect(out).not.toContain("abc123");
  });

  it("redacts an Anthropic sk-ant- key", () => {
    const out = redactSecrets("key=sk-ant-api03-abcdef123456 next");
    expect(out).toBe("key=sk-ant-***REDACTED*** next");
    expect(out).not.toContain("api03");
  });

  it("redacts a generic sk- key with ≥20 body chars", () => {
    const out = redactSecrets("OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz1234");
    expect(out).toBe("OPENAI_API_KEY=sk-***REDACTED***");
  });

  it("preserves short sk- placeholders (sk-placeholder, sk-test)", () => {
    expect(redactSecrets("config=sk-placeholder")).toBe("config=sk-placeholder");
    expect(redactSecrets("debug sk-test value")).toBe("debug sk-test value");
    expect(redactSecrets("sk-foo")).toBe("sk-foo");
  });

  it("preserves a JWT placeholder shape (header.payload.placeholder)", () => {
    // The literal docs/example shape `header.payload.placeholder` has no
    // `eyJ` prefix on the first two segments, so it must NOT match the
    // JWT regex — leave it intact for operator readability.
    const placeholder = "header.payload.placeholder";
    expect(redactSecrets(`token=${placeholder}`)).toBe(`token=${placeholder}`);
  });

  it("preserves text that matches no secret shape", () => {
    const text = "request_id=req_abc 429 Too Many Requests retry-after=3 model=gpt-4o";
    expect(redactSecrets(text)).toBe(text);
  });

  it("returns empty string unchanged", () => {
    expect(redactSecrets("")).toBe("");
  });

  it("redacts multiple shapes in the same string", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const input = `bearer Bearer abcdefghijk and jwt ${jwt} and key sk-ant-secret-token-here`;
    const out = redactSecrets(input);
    expect(out).toContain("Bearer ***REDACTED***");
    expect(out).toContain("***JWT-REDACTED***");
    expect(out).toContain("sk-ant-***REDACTED***");
    expect(out).not.toContain("eyJ");
    expect(out).not.toContain("abcdefghijk");
    expect(out).not.toContain("secret-token");
  });
});

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
});
