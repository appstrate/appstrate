// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";

/**
 * DOM-less bun runtime: install Map-backed sessionStorage and a minimal
 * `window` (config + location) BEFORE importing the module, mirroring the
 * pairing-store test pattern. `fetch` is stubbed per-test.
 */
class FakeStorage {
  private m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  getItem(key: string): string | null {
    return this.m.has(key) ? (this.m.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.m.set(key, value);
  }
  removeItem(key: string): void {
    this.m.delete(key);
  }
  clear(): void {
    this.m.clear();
  }
  key(i: number): string | null {
    return [...this.m.keys()][i] ?? null;
  }
}

const fakeSession = new FakeStorage();
(globalThis as { sessionStorage?: Storage }).sessionStorage = fakeSession;

const fakeWindow = {
  __APP_CONFIG__: {
    oidc: {
      clientId: "client_test",
      issuer: "http://localhost:3000/api/auth",
      callbackUrl: "http://localhost:3000/auth/callback",
    },
  },
  location: { search: "" },
};
(globalThis as { window?: unknown }).window = fakeWindow;

const { generateState, decodeStateRedirect, handleOidcCallback } = await import("../oidc");

const STATE_KEY = "appstrate_oidc_state";
const VERIFIER_KEY = "appstrate_oidc_verifier";
const REDIRECT_KEY = "appstrate_oidc_redirect";

/** Install a fetch stub; returns the recorded calls. */
function stubFetch(response: () => Response): Array<{ url: string; body: string }> {
  const calls: Array<{ url: string; body: string }> = [];
  (globalThis as { fetch: typeof fetch }).fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    calls.push({ url: String(input), body: String(init?.body ?? "") });
    return response();
  }) as typeof fetch;
  return calls;
}

beforeEach(() => {
  fakeSession.clear();
  fakeWindow.location.search = "";
  stubFetch(() => new Response("{}", { status: 200 }));
});

describe("generateState / decodeStateRedirect", () => {
  it("round-trips the redirect path", () => {
    const state = generateState("/invite/tok_123");
    expect(decodeStateRedirect(state)).toBe("/invite/tok_123");
  });

  it("is unique per call (random nonce)", () => {
    expect(generateState("/a")).not.toBe(generateState("/a"));
  });

  it("returns undefined when no redirect was encoded", () => {
    expect(decodeStateRedirect(generateState())).toBeUndefined();
  });

  it("returns undefined for legacy opaque random states", () => {
    // Pre-change format: 16 random bytes, base64url — not JSON.
    expect(decodeStateRedirect("qfz0eKZcRAxZ2-tk0dpwEw")).toBeUndefined();
  });

  it("rejects non-relative redirect targets (open redirect guard)", () => {
    const encode = (r: unknown) => Buffer.from(JSON.stringify({ n: "x", r })).toString("base64url");
    expect(decodeStateRedirect(encode("https://evil.example"))).toBeUndefined();
    expect(decodeStateRedirect(encode("//evil.example"))).toBeUndefined();
    expect(decodeStateRedirect(encode("/\\evil.example"))).toBeUndefined();
    expect(decodeStateRedirect(encode(42))).toBeUndefined();
    expect(decodeStateRedirect(encode("relative/no-slash"))).toBeUndefined();
  });
});

describe("handleOidcCallback — same-context flow", () => {
  it("exchanges the code and returns the stored redirect", async () => {
    const state = generateState("/invite/tok_123");
    fakeSession.setItem(STATE_KEY, state);
    fakeSession.setItem(VERIFIER_KEY, "verifier_abc");
    fakeSession.setItem(REDIRECT_KEY, "/invite/tok_123");
    fakeWindow.location.search = `?code=code_1&state=${encodeURIComponent(state)}`;
    const calls = stubFetch(() => new Response("{}", { status: 200 }));

    const { redirectTo } = await handleOidcCallback();

    expect(redirectTo).toBe("/invite/tok_123");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/auth/oauth2/token");
    expect(calls[0]!.body).toContain("code_verifier=verifier_abc");
    // One-shot: keys consumed.
    expect(fakeSession.getItem(STATE_KEY)).toBeNull();
    expect(fakeSession.getItem(VERIFIER_KEY)).toBeNull();
  });

  it("throws on a present-but-different stored state (CSRF guard)", async () => {
    fakeSession.setItem(STATE_KEY, generateState());
    fakeSession.setItem(VERIFIER_KEY, "verifier_abc");
    fakeWindow.location.search = `?code=code_1&state=${encodeURIComponent(generateState())}`;
    const calls = stubFetch(() => new Response("{}", { status: 200 }));

    await expect(handleOidcCallback()).rejects.toThrow("State mismatch");
    expect(calls).toHaveLength(0);
  });

  it("throws when the verifier is missing but the state matches", async () => {
    const state = generateState();
    fakeSession.setItem(STATE_KEY, state);
    fakeWindow.location.search = `?code=code_1&state=${encodeURIComponent(state)}`;

    await expect(handleOidcCallback()).rejects.toThrow("Missing code verifier");
  });
});

describe("handleOidcCallback — cross-context resume (email verification link)", () => {
  it("skips the exchange and recovers the redirect from the echoed state", async () => {
    // New tab/device: sessionStorage is empty, state arrives only via URL.
    const state = generateState("/invite/tok_123");
    fakeWindow.location.search = `?code=code_1&state=${encodeURIComponent(state)}`;
    const calls = stubFetch(() => new Response("{}", { status: 200 }));

    const { redirectTo } = await handleOidcCallback();

    expect(redirectTo).toBe("/invite/tok_123");
    expect(calls).toHaveLength(0); // no verifier → no token exchange
  });

  it("falls back to / when the echoed state carries no redirect", async () => {
    fakeWindow.location.search = `?code=code_1&state=${encodeURIComponent(generateState())}`;

    const { redirectTo } = await handleOidcCallback();

    expect(redirectTo).toBe("/");
  });

  it("falls back to / on a crafted non-relative redirect", async () => {
    const evil = Buffer.from(JSON.stringify({ n: "x", r: "https://evil.example" })).toString(
      "base64url",
    );
    fakeWindow.location.search = `?code=code_1&state=${encodeURIComponent(evil)}`;

    const { redirectTo } = await handleOidcCallback();

    expect(redirectTo).toBe("/");
  });

  it("still reports the provider error before attempting recovery", async () => {
    fakeWindow.location.search = `?error=access_denied&state=x`;

    await expect(handleOidcCallback()).rejects.toThrow("OIDC error: access_denied");
  });
});
