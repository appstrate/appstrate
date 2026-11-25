// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  parseBearerChallenge,
  requiredScopesFromChallenge,
  sanitiseRequiredScopes,
  MAX_REQUIRED_SCOPE_LENGTH,
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
  it("drops invalid scope tokens and caps at 20", () => {
    expect(requiredScopesFromChallenge(401, 'Bearer scope="ok bad\\"q"')).toEqual(["ok"]);
    const many = Array.from({ length: 30 }, (_, i) => `s${i}`).join(" ");
    expect(requiredScopesFromChallenge(401, `Bearer scope="${many}"`)).toHaveLength(20);
  });
  it("drops scope tokens over 128 characters", () => {
    const header = `Bearer scope="${"x".repeat(129)} ${"y".repeat(128)}"`;
    expect(requiredScopesFromChallenge(401, header)).toEqual(["y".repeat(128)]);
  });
});

describe("sanitiseRequiredScopes", () => {
  it("keeps valid tokens and drops non-strings and invalid tokens", () => {
    expect(sanitiseRequiredScopes(["read", 3, null, "has space", "write"])).toEqual([
      "read",
      "write",
    ]);
  });

  it("drops tokens over the length bound", () => {
    expect(sanitiseRequiredScopes(["a".repeat(MAX_REQUIRED_SCOPE_LENGTH + 1), "ok"])).toEqual([
      "ok",
    ]);
  });

  it("caps the list at 20", () => {
    const many = Array.from({ length: 30 }, (_, i) => `s${i}`);
    expect(sanitiseRequiredScopes(many)).toHaveLength(20);
  });

  it("returns an empty list for undefined", () => {
    expect(sanitiseRequiredScopes(undefined)).toEqual([]);
  });
});
