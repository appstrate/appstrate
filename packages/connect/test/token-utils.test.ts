// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  parseTokenResponse,
  parseTokenErrorResponse,
  buildTokenHeaders,
  buildTokenBody,
} from "../src/token-utils.ts";

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
    expect(() => parseTokenResponse({})).toThrow("No (string) access_token");
  });

  it("throws when access_token is a non-string", () => {
    expect(() => parseTokenResponse({ access_token: 12345 })).toThrow("No (string) access_token");
  });

  it("coerces a string expires_in (Azure AD v1 / Keycloak)", () => {
    const before = Date.now();
    const result = parseTokenResponse({ ...baseToken, expires_in: "3600" });
    expect(result.expiresAt).not.toBeNull();
    const ms = new Date(result.expiresAt!).getTime();
    expect(ms).toBeGreaterThanOrEqual(before + 3600 * 1000 - 1000);
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

describe("parseTokenResponse — scope diff", () => {
  const baseToken = { access_token: "tok_x" };

  it("reports zero shortfall and creep when granted == requested", () => {
    const result = parseTokenResponse({ ...baseToken, scope: "read:user repo" }, [
      "read:user",
      "repo",
    ]);
    expect(result.scopeShortfall).toEqual([]);
    expect(result.scopeCreep).toEqual([]);
  });

  it("reports shortfall when provider grants fewer scopes than requested", () => {
    const result = parseTokenResponse({ ...baseToken, scope: "read:user" }, ["read:user", "repo"]);
    expect(result.scopeShortfall).toEqual(["repo"]);
    expect(result.scopeCreep).toEqual([]);
  });

  it("reports creep when provider grants extra scopes (Slack-style super-set)", () => {
    const result = parseTokenResponse({ ...baseToken, scope: "read:user repo admin" }, [
      "read:user",
      "repo",
    ]);
    expect(result.scopeShortfall).toEqual([]);
    expect(result.scopeCreep).toEqual(["admin"]);
  });

  it("reports both shortfall and creep simultaneously", () => {
    const result = parseTokenResponse({ ...baseToken, scope: "different:scope" }, [
      "read:user",
      "repo",
    ]);
    expect(result.scopeShortfall).toEqual(["read:user", "repo"]);
    expect(result.scopeCreep).toEqual(["different:scope"]);
  });

  it("treats missing scope field as 'requested == granted' (no signal)", () => {
    // When the provider omits `scope`, we fall back to requestedScopes; that's
    // the documented assumption that the request was granted in full.
    const result = parseTokenResponse(baseToken, ["read:user", "repo"]);
    expect(result.scopesGranted).toEqual(["read:user", "repo"]);
    expect(result.scopeShortfall).toEqual([]);
    expect(result.scopeCreep).toEqual([]);
  });

  it("treats no requested scopes as no shortfall, all granted as creep", () => {
    const result = parseTokenResponse({ ...baseToken, scope: "read:user" });
    expect(result.scopeShortfall).toEqual([]);
    expect(result.scopeCreep).toEqual(["read:user"]);
  });
});

describe("parseTokenErrorResponse", () => {
  it("classifies HTTP 400 + invalid_grant as 'revoked' (RFC 6749 §5.2)", () => {
    const result = parseTokenErrorResponse(400, JSON.stringify({ error: "invalid_grant" }));
    expect(result.kind).toBe("revoked");
    expect(result.error).toBe("invalid_grant");
  });

  it("preserves error_description on revoked classification", () => {
    const result = parseTokenErrorResponse(
      400,
      JSON.stringify({ error: "invalid_grant", error_description: "Token has been revoked" }),
    );
    expect(result.kind).toBe("revoked");
    expect(result.errorDescription).toBe("Token has been revoked");
  });

  it("classifies HTTP 400 + other OAuth error codes as 'transient'", () => {
    const result = parseTokenErrorResponse(400, JSON.stringify({ error: "invalid_client" }));
    expect(result.kind).toBe("transient");
    expect(result.error).toBe("invalid_client");
  });

  it("classifies HTTP 400 + non-JSON body as 'transient'", () => {
    const result = parseTokenErrorResponse(400, "<html>Bad Request</html>");
    expect(result.kind).toBe("transient");
    expect(result.error).toBeUndefined();
  });

  it("classifies HTTP 5xx as 'transient' regardless of body", () => {
    const result = parseTokenErrorResponse(500, JSON.stringify({ error: "invalid_grant" }));
    expect(result.kind).toBe("transient");
  });

  it("classifies HTTP 401/403 as 'transient'", () => {
    expect(parseTokenErrorResponse(401, "").kind).toBe("transient");
    expect(parseTokenErrorResponse(403, "").kind).toBe("transient");
  });

  // RFC 6749 §5.2: an AS that gets client credentials in the Authorization
  // header MUST answer `invalid_client` with 401, so the code only reaches an
  // operator if 401 bodies are parsed too. A manifest declaring the wrong
  // `token_endpoint_auth_method` is precisely this failure.
  it("extracts the OAuth error code from an HTTP 401 body", () => {
    const result = parseTokenErrorResponse(
      401,
      JSON.stringify({
        error: "invalid_client",
        error_description: "Client authentication failed",
      }),
    );
    expect(result.kind).toBe("transient");
    expect(result.error).toBe("invalid_client");
    expect(result.errorDescription).toBe("Client authentication failed");
  });

  it("classifies HTTP 401 + invalid_grant as 'revoked'", () => {
    const result = parseTokenErrorResponse(401, JSON.stringify({ error: "invalid_grant" }));
    expect(result.kind).toBe("revoked");
    expect(result.error).toBe("invalid_grant");
  });

  it("classifies HTTP 401 + non-JSON body as 'transient' with no code", () => {
    const result = parseTokenErrorResponse(401, "<html>Unauthorized</html>");
    expect(result.kind).toBe("transient");
    expect(result.error).toBeUndefined();
  });

  it("does not parse bodies on statuses other than 400/401", () => {
    const result = parseTokenErrorResponse(403, JSON.stringify({ error: "invalid_client" }));
    expect(result.kind).toBe("transient");
    expect(result.error).toBeUndefined();
  });

  it("classifies empty body as 'transient'", () => {
    expect(parseTokenErrorResponse(400, "").kind).toBe("transient");
  });
});

describe("buildTokenHeaders", () => {
  it("defaults to form-urlencoded content type", () => {
    const headers = buildTokenHeaders(undefined, "client_id", "client_secret");
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
  });

  it("sets Basic auth header for client_secret_basic", () => {
    const headers = buildTokenHeaders("client_secret_basic", "my_id", "my_secret");
    expect(headers["Authorization"]).toStartWith("Basic ");
    const decoded = Buffer.from(headers["Authorization"]!.slice(6), "base64").toString();
    expect(decoded).toBe("my_id:my_secret");
  });
});

describe("buildTokenBody", () => {
  it("builds form-urlencoded body by default", () => {
    const body = buildTokenBody({ grant_type: "authorization_code", code: "abc" });
    expect(body).toContain("grant_type=authorization_code");
    expect(body).toContain("code=abc");
  });

  it("builds form-urlencoded from the params map", () => {
    const body = buildTokenBody({ key: "value" });
    expect(body).toBe("key=value");
  });
});
