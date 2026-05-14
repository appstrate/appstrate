// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  exchangePasswordGrant,
  refreshPasswordGrantToken,
  PasswordGrantError,
  type PasswordGrantContext,
} from "../src/password-grant.ts";

const originalFetch = globalThis.fetch;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain" } });
}

interface CapturedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

function mockFetchCapture(response: Response): { captured: CapturedRequest | null } {
  const state: { captured: CapturedRequest | null } = { captured: null };
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    state.captured = {
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : "",
    };
    return response;
  }) as unknown as typeof fetch;
  return state;
}

const baseCtx: PasswordGrantContext = {
  tokenUrl: "https://oauth.example.com/token",
  clientId: "cid",
  clientSecret: "csec",
  providerId: "amisgest",
};

describe("exchangePasswordGrant", () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("happy path — form-urlencoded, client_secret_post, returns parsed tokens", async () => {
    const state = mockFetchCapture(
      jsonResponse(200, {
        access_token: "AT-1",
        refresh_token: "RT-1",
        token_type: "Bearer",
        expires_in: 3600,
      }),
    );

    const parsed = await exchangePasswordGrant(baseCtx, "alice", "s3cret");

    expect(parsed.accessToken).toBe("AT-1");
    expect(parsed.refreshToken).toBe("RT-1");
    expect(parsed.expiresAt).toBeTruthy();

    // Verify the wire format.
    expect(state.captured?.url).toBe("https://oauth.example.com/token");
    expect(state.captured?.method).toBe("POST");
    expect(state.captured?.headers.get("Content-Type")).toBe("application/x-www-form-urlencoded");
    expect(state.captured?.headers.get("Authorization")).toBeNull();

    const params = new URLSearchParams(state.captured?.body ?? "");
    expect(params.get("grant_type")).toBe("password");
    expect(params.get("username")).toBe("alice");
    expect(params.get("password")).toBe("s3cret");
    expect(params.get("client_id")).toBe("cid");
    expect(params.get("client_secret")).toBe("csec");
  });

  it("client_secret_basic sends Authorization header, omits client_id/secret from body", async () => {
    const state = mockFetchCapture(
      jsonResponse(200, { access_token: "AT-2", token_type: "Bearer" }),
    );

    await exchangePasswordGrant(
      { ...baseCtx, tokenAuthMethod: "client_secret_basic" },
      "alice",
      "s3cret",
    );

    const auth = state.captured?.headers.get("Authorization");
    expect(auth).toBeTruthy();
    expect(auth!.startsWith("Basic ")).toBe(true);
    const decoded = Buffer.from(auth!.slice("Basic ".length), "base64").toString("utf8");
    expect(decoded).toBe("cid:csec");

    const params = new URLSearchParams(state.captured?.body ?? "");
    expect(params.get("client_id")).toBeNull();
    expect(params.get("client_secret")).toBeNull();
    expect(params.get("grant_type")).toBe("password");
  });

  it("JSON content type sends a JSON body", async () => {
    const state = mockFetchCapture(
      jsonResponse(200, { access_token: "AT-3", token_type: "Bearer" }),
    );

    await exchangePasswordGrant(
      { ...baseCtx, tokenContentType: "application/json" },
      "alice",
      "s3cret",
    );

    expect(state.captured?.headers.get("Content-Type")).toBe("application/json");
    const parsed = JSON.parse(state.captured?.body ?? "{}") as Record<string, string>;
    expect(parsed.grant_type).toBe("password");
    expect(parsed.username).toBe("alice");
    expect(parsed.password).toBe("s3cret");
  });

  it("scope is sent in the token body when set", async () => {
    const state = mockFetchCapture(
      jsonResponse(200, { access_token: "AT-4", token_type: "Bearer" }),
    );

    await exchangePasswordGrant({ ...baseCtx, scope: "read write" }, "alice", "s3cret");

    const params = new URLSearchParams(state.captured?.body ?? "");
    expect(params.get("scope")).toBe("read write");
  });

  it("public client (no clientId / clientSecret) sends neither header nor body fields", async () => {
    const state = mockFetchCapture(
      jsonResponse(200, { access_token: "AT-5", token_type: "Bearer" }),
    );

    await exchangePasswordGrant(
      { tokenUrl: baseCtx.tokenUrl, providerId: "fizz" },
      "alice",
      "s3cret",
    );

    expect(state.captured?.headers.get("Authorization")).toBeNull();
    const params = new URLSearchParams(state.captured?.body ?? "");
    expect(params.get("client_id")).toBeNull();
    expect(params.get("client_secret")).toBeNull();
  });

  it('400 + {"error":"invalid_grant"} → kind = "revoked"', async () => {
    globalThis.fetch = mock(async () =>
      jsonResponse(400, { error: "invalid_grant" }),
    ) as unknown as typeof fetch;

    try {
      await exchangePasswordGrant(baseCtx, "alice", "wrong");
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PasswordGrantError);
      expect((err as PasswordGrantError).kind).toBe("revoked");
      expect((err as PasswordGrantError).status).toBe(400);
      expect((err as PasswordGrantError).oauthError).toBe("invalid_grant");
    }
  });

  it('401 + {"error":"invalid_client"} → "transient"', async () => {
    globalThis.fetch = mock(async () =>
      jsonResponse(401, { error: "invalid_client" }),
    ) as unknown as typeof fetch;

    try {
      await exchangePasswordGrant(baseCtx, "alice", "s3cret");
      throw new Error("expected to throw");
    } catch (err) {
      expect((err as PasswordGrantError).kind).toBe("transient");
      expect((err as PasswordGrantError).status).toBe(401);
    }
  });

  it("network error → transient", async () => {
    globalThis.fetch = mock(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    try {
      await exchangePasswordGrant(baseCtx, "alice", "s3cret");
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PasswordGrantError);
      expect((err as PasswordGrantError).kind).toBe("transient");
      expect((err as PasswordGrantError).status).toBeUndefined();
    }
  });

  it("200 with non-JSON body → transient", async () => {
    globalThis.fetch = mock(async () =>
      textResponse(200, "<html>not json</html>"),
    ) as unknown as typeof fetch;

    try {
      await exchangePasswordGrant(baseCtx, "alice", "s3cret");
      throw new Error("expected to throw");
    } catch (err) {
      expect((err as PasswordGrantError).kind).toBe("transient");
    }
  });

  it("200 without access_token → throws (parseTokenResponse contract)", async () => {
    globalThis.fetch = mock(async () =>
      jsonResponse(200, { token_type: "Bearer" }),
    ) as unknown as typeof fetch;

    await expect(exchangePasswordGrant(baseCtx, "alice", "s3cret")).rejects.toThrow(
      /No access_token/,
    );
  });

  it("200 without refresh_token still succeeds — refreshToken is undefined", async () => {
    globalThis.fetch = mock(async () =>
      jsonResponse(200, { access_token: "AT-norefresh", token_type: "Bearer" }),
    ) as unknown as typeof fetch;

    const parsed = await exchangePasswordGrant(baseCtx, "alice", "s3cret");
    expect(parsed.accessToken).toBe("AT-norefresh");
    expect(parsed.refreshToken).toBeUndefined();
  });
});

describe("refreshPasswordGrantToken", () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends grant_type=refresh_token with the supplied refresh_token", async () => {
    const state = mockFetchCapture(
      jsonResponse(200, {
        access_token: "AT-refreshed",
        refresh_token: "RT-rotated",
        token_type: "Bearer",
        expires_in: 3600,
      }),
    );

    const parsed = await refreshPasswordGrantToken(baseCtx, "RT-old");

    expect(parsed.accessToken).toBe("AT-refreshed");
    expect(parsed.refreshToken).toBe("RT-rotated");

    const params = new URLSearchParams(state.captured?.body ?? "");
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("refresh_token")).toBe("RT-old");
    expect(params.get("username")).toBeNull();
    expect(params.get("password")).toBeNull();
  });

  it('400 + {"error":"invalid_grant"} → "revoked" (refresh token dead)', async () => {
    globalThis.fetch = mock(async () =>
      jsonResponse(400, { error: "invalid_grant" }),
    ) as unknown as typeof fetch;

    try {
      await refreshPasswordGrantToken(baseCtx, "RT-dead");
      throw new Error("expected to throw");
    } catch (err) {
      expect((err as PasswordGrantError).kind).toBe("revoked");
    }
  });
});
