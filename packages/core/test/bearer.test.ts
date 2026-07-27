// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { parseBearer } from "../src/bearer.ts";

describe("parseBearer", () => {
  it("matches the scheme case-insensitively (RFC 9110 §11.4 — auth-scheme is a token)", () => {
    expect(parseBearer("Bearer x")).toBe("x");
    expect(parseBearer("bearer x")).toBe("x");
    expect(parseBearer("BEARER x")).toBe("x");
    expect(parseBearer("BeArEr x")).toBe("x");
  });

  it("accepts more than one SP between scheme and token (1*SP)", () => {
    expect(parseBearer("Bearer  x")).toBe("x");
    expect(parseBearer("Bearer     ask_key")).toBe("ask_key");
  });

  it("returns null for a missing or empty header", () => {
    expect(parseBearer(null)).toBeNull();
    expect(parseBearer(undefined)).toBeNull();
    expect(parseBearer("")).toBeNull();
  });

  it("returns null for a different auth-scheme", () => {
    expect(parseBearer("Basic x")).toBeNull();
    expect(parseBearer("basic x")).toBeNull();
    // A scheme that merely starts with the same bytes is not `bearer`.
    expect(parseBearer("Bearerish x")).toBeNull();
  });

  it("returns null when no token follows the scheme", () => {
    expect(parseBearer("Bearer")).toBeNull();
    expect(parseBearer("Bearer ")).toBeNull();
    // Scheme + separator run and nothing else — must not yield a
    // whitespace "token" by backtracking into the separator.
    expect(parseBearer("Bearer   ")).toBeNull();
  });

  it("requires SP as the separator, not HTAB (excluded by the grammar)", () => {
    expect(parseBearer("Bearer\tx")).toBeNull();
  });

  it("returns a token containing spaces verbatim", () => {
    // token68 forbids inner spaces, but rejecting is the caller's job —
    // the parser must not silently truncate at the first inner space.
    expect(parseBearer("Bearer a b")).toBe("a b");
    expect(parseBearer("Bearer x ")).toBe("x ");
  });

  it("preserves token case — API keys and JWTs are case-sensitive", () => {
    expect(parseBearer("bearer ASK_MiXeD_Case")).toBe("ASK_MiXeD_Case");
    expect(parseBearer("BEARER eyJhbGciOiJFUzI1NiJ9.PaYlOaD.SiG")).toBe(
      "eyJhbGciOiJFUzI1NiJ9.PaYlOaD.SiG",
    );
  });
});
