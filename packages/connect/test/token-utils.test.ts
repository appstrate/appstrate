// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  parseTokenResponse,
  parseTokenErrorResponse,
  classifyTokenErrorBody,
  readTokenResponse,
  buildTokenHeaders,
  buildTokenBody,
} from "../src/token-utils.ts";

describe("parseTokenResponse", () => {
  const baseToken = { access_token: "tok_123" };

  it("parses space-separated scopes", () => {
    const result = parseTokenResponse({ ...baseToken, scope: "read:user repo" });
    expect(result.scopesReturned).toEqual(["read:user", "repo"]);
  });

  it("parses comma-separated scopes (GitHub-style)", () => {
    const result = parseTokenResponse({ ...baseToken, scope: "read:user,repo" });
    expect(result.scopesReturned).toEqual(["read:user", "repo"]);
  });

  it("parses mixed comma and space separators", () => {
    const result = parseTokenResponse({ ...baseToken, scope: "read:user, repo workflow" });
    expect(result.scopesReturned).toEqual(["read:user", "repo", "workflow"]);
  });

  it("parses %20-separated scopes", () => {
    const result = parseTokenResponse({ ...baseToken, scope: "read:user%20repo" });
    expect(result.scopesReturned).toEqual(["read:user", "repo"]);
  });

  it("returns null when the response omits scope (RFC 6749 §5.1)", () => {
    expect(parseTokenResponse(baseToken).scopesReturned).toBeNull();
    expect(parseTokenResponse({ ...baseToken, scope: null }).scopesReturned).toBeNull();
  });

  it("returns null for an echoed scope with no token, as if omitted", () => {
    expect(parseTokenResponse({ ...baseToken, scope: " " }).scopesReturned).toBeNull();
    expect(parseTokenResponse({ ...baseToken, scope: "" }).scopesReturned).toBeNull();
  });

  it("extracts accessToken", () => {
    const result = parseTokenResponse(baseToken);
    expect(result.accessToken).toBe("tok_123");
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
    const result = parseTokenResponse(baseToken, "rt_old");
    expect(result.refreshToken).toBe("rt_old");
  });

  it("prefers response refresh token over fallback", () => {
    const result = parseTokenResponse({ ...baseToken, refresh_token: "rt_new" }, "rt_old");
    expect(result.refreshToken).toBe("rt_new");
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

describe("classifyTokenErrorBody", () => {
  it("classifies invalid_grant as 'revoked'", () => {
    expect(classifyTokenErrorBody({ error: "invalid_grant" })).toEqual({
      kind: "revoked",
      error: "invalid_grant",
      errorDescription: undefined,
    });
  });

  // No provider-specific list: only the standard code declares a credential dead.
  it("keeps any other code 'transient' and redacts the description", () => {
    const result = classifyTokenErrorBody({
      error: "bad_refresh_token",
      error_description: "token ghr_0123456789abcdefABCDEF0123456789abcd is bad",
    });
    expect(result.kind).toBe("transient");
    expect(result.error).toBe("bad_refresh_token");
    expect(result.errorDescription).toBe("token [redacted] is bad");
  });

  it("classifies a body with no string error as 'transient' with no code", () => {
    expect(classifyTokenErrorBody({})).toEqual({ kind: "transient" });
    expect(classifyTokenErrorBody({ error: 42 }).error).toBeUndefined();
    expect(classifyTokenErrorBody(null)).toEqual({ kind: "transient" });
    expect(classifyTokenErrorBody("invalid_grant")).toEqual({ kind: "transient" });
  });
});

describe("readTokenResponse", () => {
  function json(body: unknown, status: number): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  it("returns the body of a 2xx that carries an access_token", async () => {
    const read = await readTokenResponse(json({ access_token: "tok", scope: "a" }, 200));
    expect(read).toEqual({ ok: true, raw: { access_token: "tok", scope: "a" } });
  });

  it("summarizes a classified non-2xx as code and description, raw text on body", async () => {
    const text = JSON.stringify({ error: "invalid_grant", error_description: "gone" });
    const read = await readTokenResponse(new Response(text, { status: 400 }));
    expect(read).toEqual({
      ok: false,
      kind: "revoked",
      status: 400,
      summary: "invalid_grant — gone",
      body: text,
      error: "invalid_grant",
      errorDescription: "gone",
    });
  });

  it("uses the code alone when there is no description", async () => {
    const read = await readTokenResponse(json({ error: "invalid_grant" }, 401));
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.summary).toBe("invalid_grant");
  });

  it("falls back to the status when the body named no code", async () => {
    const read = await readTokenResponse(new Response("<html>down</html>", { status: 503 }));
    expect(read).toMatchObject({ ok: false, kind: "transient", status: 503, summary: "HTTP 503" });
  });

  it("classifies a non-JSON 2xx as transient with the parse error as cause", async () => {
    const read = await readTokenResponse(new Response("<html>gateway</html>", { status: 200 }));
    expect(read).toMatchObject({ ok: false, kind: "transient", status: 200 });
    if (!read.ok) {
      expect(read.summary).toBe("non-JSON response");
      expect(read.body).toBeUndefined();
      expect(read.cause).toBeInstanceOf(SyntaxError);
    }
  });

  it("classifies a 2xx JSON body without a (string, non-empty) access_token", async () => {
    for (const body of [{}, { access_token: 12345 }, { access_token: "" }]) {
      const read = await readTokenResponse(json(body, 200));
      expect(read).toMatchObject({
        ok: false,
        kind: "transient",
        summary: "HTTP 200 without access_token",
        body: JSON.stringify(body),
      });
    }
    expect(await readTokenResponse(json({ error: "invalid_grant" }, 200))).toMatchObject({
      ok: false,
      kind: "revoked",
      summary: "invalid_grant",
    });
  });

  it("never puts the raw body in the summary", async () => {
    const MARKER = "LEAKED_CODE_abc123_should_not_appear";
    const read = await readTokenResponse(json({ error: "invalid_grant", reflected: MARKER }, 400));
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.summary).not.toContain(MARKER);
      expect(read.body).toContain(MARKER);
    }
  });
});

describe("buildTokenHeaders", () => {
  it("defaults to form-urlencoded content type", () => {
    const headers = buildTokenHeaders(undefined, "client_id", "client_secret");
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
  });

  it("sets Basic auth header for client_secret_basic", () => {
    const headers = buildTokenHeaders("client_secret_basic", "my_id", "my_secret");
    expect(headers["Authorization"]).toBe(`Basic ${btoa("my_id:my_secret")}`);
  });

  it("form-urlencodes each credential before base64 (RFC 6749 §2.3.1, Appendix B)", () => {
    const headers = buildTokenHeaders("client_secret_basic", "my id", "a:b c+d%é!");
    expect(headers["Authorization"]).toBe("Basic bXkraWQ6YSUzQWIrYyUyQmQlMjUlQzMlQTklMjE=");
    expect(atob(headers["Authorization"]!.slice(6))).toBe("my+id:a%3Ab+c%2Bd%25%C3%A9%21");
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
