// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { parseTokenResponse } from "../src/token-utils.ts";

describe("parseTokenResponse", () => {
  const baseToken = { access_token: "tok_123" };

  it("parses space-separated scopes", () => {
    const result = parseTokenResponse({ ...baseToken, scope: "read:user repo" });
    expect(result.scopesGranted).toEqual(["read:user", "repo"]);
  });

  it("parses comma-separated scopes (GitHub-style)", () => {
    const result = parseTokenResponse({ ...baseToken, scope: "read:user,repo" });
    expect(result.scopesGranted).toEqual(["read:user", "repo"]);
  });

  it("parses mixed comma and space separators", () => {
    const result = parseTokenResponse({ ...baseToken, scope: "read:user, repo workflow" });
    expect(result.scopesGranted).toEqual(["read:user", "repo", "workflow"]);
  });

  it("parses %20-separated scopes", () => {
    const result = parseTokenResponse({ ...baseToken, scope: "read:user%20repo" });
    expect(result.scopesGranted).toEqual(["read:user", "repo"]);
  });

  it("uses fallback scopes when scope is missing", () => {
    const result = parseTokenResponse(baseToken, ["fallback"]);
    expect(result.scopesGranted).toEqual(["fallback"]);
  });

  it("returns empty array when no scope and no fallback", () => {
    const result = parseTokenResponse(baseToken);
    expect(result.scopesGranted).toEqual([]);
  });

  it("extracts accessToken", () => {
    const result = parseTokenResponse(baseToken);
    expect(result.accessToken).toBe("tok_123");
  });

  it("throws when access_token is missing", () => {
    expect(() => parseTokenResponse({})).toThrow("No access_token");
  });

  it("computes expiresAt from expires_in", () => {
    const before = Date.now();
    const result = parseTokenResponse({ ...baseToken, expires_in: 3600 });
    const after = Date.now();
    expect(result.expiresAt).not.toBeNull();
    const ts = new Date(result.expiresAt!).getTime();
    expect(ts).toBeGreaterThanOrEqual(before + 3600 * 1000);
    expect(ts).toBeLessThanOrEqual(after + 3600 * 1000);
  });

  it("preserves fallback refresh token", () => {
    const result = parseTokenResponse(baseToken, undefined, "rt_old");
    expect(result.refreshToken).toBe("rt_old");
  });

  it("prefers response refresh token over fallback", () => {
    const result = parseTokenResponse(
      { ...baseToken, refresh_token: "rt_new" },
      undefined,
      "rt_old",
    );
    expect(result.refreshToken).toBe("rt_new");
  });
});
