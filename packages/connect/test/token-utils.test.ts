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

  it("classifies empty body as 'transient'", () => {
    expect(parseTokenErrorResponse(400, "").kind).toBe("transient");
  });
});

describe("buildTokenHeaders", () => {
  it("defaults to form-urlencoded content type", () => {
    const headers = buildTokenHeaders(undefined, "client_id", "client_secret");
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
  });

  it("uses JSON content type when tokenContentType is application/json", () => {
    const headers = buildTokenHeaders(undefined, "client_id", "client_secret", "application/json");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("sets Basic auth header for client_secret_basic", () => {
    const headers = buildTokenHeaders("client_secret_basic", "my_id", "my_secret");
    expect(headers["Authorization"]).toStartWith("Basic ");
    const decoded = Buffer.from(headers["Authorization"]!.slice(6), "base64").toString();
    expect(decoded).toBe("my_id:my_secret");
  });

  it("combines Basic auth with JSON content type", () => {
    const headers = buildTokenHeaders("client_secret_basic", "id", "secret", "application/json");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Authorization"]).toStartWith("Basic ");
  });
});

describe("buildTokenBody", () => {
  it("builds form-urlencoded body by default", () => {
    const body = buildTokenBody({ grant_type: "authorization_code", code: "abc" });
    expect(body).toContain("grant_type=authorization_code");
    expect(body).toContain("code=abc");
  });

  it("builds JSON body when tokenContentType is application/json", () => {
    const body = buildTokenBody(
      { grant_type: "authorization_code", code: "abc" },
      "application/json",
    );
    const parsed = JSON.parse(body);
    expect(parsed.grant_type).toBe("authorization_code");
    expect(parsed.code).toBe("abc");
  });

  it("builds form-urlencoded for undefined tokenContentType", () => {
    const body = buildTokenBody({ key: "value" }, undefined);
    expect(body).toBe("key=value");
  });
});

// Exercises the exact body/header shape that token-refresh.ts builds in doRefresh().
// Guards against regressions on the Atlassian/Jira JSON refresh flow without requiring
// a full fetch/Db integration test.
describe("refresh flow request shape", () => {
  const ctx = {
    clientId: "jira_client",
    clientSecret: "jira_secret",
    refreshToken: "rt_abc",
  };

  function buildRefreshBodyParams(useBasicAuth: boolean) {
    return {
      grant_type: "refresh_token",
      refresh_token: ctx.refreshToken,
      ...(useBasicAuth ? {} : { client_id: ctx.clientId, client_secret: ctx.clientSecret }),
    };
  }

  it("builds a JSON body without client credentials when using client_secret_basic + JSON", () => {
    const params = buildRefreshBodyParams(true);
    const body = buildTokenBody(params, "application/json");
    const headers = buildTokenHeaders(
      "client_secret_basic",
      ctx.clientId,
      ctx.clientSecret,
      "application/json",
    );

    const parsed = JSON.parse(body);
    expect(parsed).toEqual({ grant_type: "refresh_token", refresh_token: "rt_abc" });
    expect(parsed.client_id).toBeUndefined();
    expect(parsed.client_secret).toBeUndefined();
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Authorization"]).toStartWith("Basic ");
  });

  it("builds a JSON body including client credentials for client_secret_post + JSON", () => {
    const params = buildRefreshBodyParams(false);
    const body = buildTokenBody(params, "application/json");
    const headers = buildTokenHeaders(
      "client_secret_post",
      ctx.clientId,
      ctx.clientSecret,
      "application/json",
    );

    const parsed = JSON.parse(body);
    expect(parsed.client_id).toBe("jira_client");
    expect(parsed.client_secret).toBe("jira_secret");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("falls back to form-urlencoded when tokenContentType is undefined", () => {
    const params = buildRefreshBodyParams(false);
    const body = buildTokenBody(params, undefined);
    const headers = buildTokenHeaders(undefined, ctx.clientId, ctx.clientSecret, undefined);

    expect(body).toContain("grant_type=refresh_token");
    expect(body).toContain("refresh_token=rt_abc");
    expect(body).toContain("client_id=jira_client");
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
  });
});
