// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  parseBearerChallenge,
  requiredScopesFromChallenge,
  sanitiseRequiredScopes,
} from "../src/www-authenticate.ts";

describe("Bearer resource metadata (RFC 9728 §5.1)", () => {
  it("extracts resource_metadata from a WWW-Authenticate challenge", () => {
    const header =
      'Bearer realm="MCP Server", error="invalid_token", resource_metadata="https://mcp.clickup.com/.well-known/oauth-protected-resource/mcp"';
    expect(parseBearerChallenge(header)?.resourceMetadataUrl).toBe(
      "https://mcp.clickup.com/.well-known/oauth-protected-resource/mcp",
    );
  });

  it("returns undefined when absent", () => {
    expect(parseBearerChallenge('Bearer realm="x"')?.resourceMetadataUrl).toBeUndefined();
  });
});

describe("Bearer scopes (RFC 6750 §3)", () => {
  it("splits the space-delimited scope parameter", () => {
    const header =
      'Bearer error="invalid_token", resource_metadata="https://mcp.linear.app/.well-known/oauth-protected-resource/mcp", scope="read write"';
    expect(parseBearerChallenge(header)?.scopes).toEqual(["read", "write"]);
  });

  it("returns undefined without a scope, or with an empty one", () => {
    expect(
      parseBearerChallenge('Bearer resource_metadata="https://x/meta"')?.scopes,
    ).toBeUndefined();
    expect(parseBearerChallenge('Bearer scope=""')?.scopes).toBeUndefined();
  });

  it("binds parameters to their scheme and keeps quoted commas and escaped quotes inside a value", () => {
    const header =
      'Basic realm="one, \\"Bearer\\"", scope="wrong", Bearer realm="two, three", scope="read write", Digest resource_metadata="https://other.test/"';
    expect(parseBearerChallenge(header)?.scopes).toEqual(["read", "write"]);
    expect(parseBearerChallenge(header)?.resourceMetadataUrl).toBeUndefined();
    expect(parseBearerChallenge('Bearer realm="one", Basic scope="wrong"')?.scopes).toBeUndefined();
    expect(parseBearerChallenge('Basic realm="one, Bearer scope=wrong"')?.scopes).toBeUndefined();
  });

  it("keeps the first value of a repeated parameter", () => {
    expect(parseBearerChallenge('Bearer scope="read", scope="admin"')?.scopes).toEqual(["read"]);
  });

  it("does not read a parameter merely ending in scope", () => {
    expect(parseBearerChallenge('Bearer x_scope="admin"')?.scopes).toBeUndefined();
  });
});

describe("Bearer error (RFC 6750 §3.1)", () => {
  it("reads the error code alongside the scopes", () => {
    expect(parseBearerChallenge('Bearer error="insufficient_scope", scope="a b"')).toEqual({
      error: "insufficient_scope",
      scopes: ["a", "b"],
    });
  });
});

describe("requiredScopesFromChallenge", () => {
  const h = 'Bearer error="insufficient_scope", scope="a b"';
  it("reads scopes on a 401 and on a 403 insufficient_scope", () => {
    expect(requiredScopesFromChallenge(403, h)).toEqual(["a", "b"]);
    expect(requiredScopesFromChallenge(401, 'Bearer scope="a"')).toEqual(["a"]);
  });
  it("ignores a 403 without insufficient_scope, other statuses and a missing header", () => {
    expect(
      requiredScopesFromChallenge(403, 'Bearer error="invalid_token", scope="a"'),
    ).toBeUndefined();
    expect(requiredScopesFromChallenge(403, 'Bearer scope="a"')).toBeUndefined();
    expect(requiredScopesFromChallenge(500, h)).toBeUndefined();
    expect(requiredScopesFromChallenge(401, null)).toBeUndefined();
  });
});

describe("sanitiseRequiredScopes", () => {
  const cases: [readonly unknown[] | undefined, string[]][] = [
    [
      ["read", 3, null, "has space", "write"],
      ["read", "write"],
    ],
    [["a".repeat(129), "ok"], ["ok"]],
    [Array.from({ length: 30 }, (_, i) => `s${i}`), Array.from({ length: 20 }, (_, i) => `s${i}`)],
    [undefined, []],
  ];
  it.each(cases)("sanitises %j", (input, expected) => {
    expect(sanitiseRequiredScopes(input)).toEqual(expected);
  });
});
