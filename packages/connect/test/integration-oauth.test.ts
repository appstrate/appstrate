// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import {
  initiateIntegrationOAuth,
  handleIntegrationOAuthCallback,
  OAuthCallbackError,
  type OAuthStateRecord,
  type OAuthStateStore,
} from "../src/index.ts";

function memoryStore(): OAuthStateStore & { _data: Map<string, OAuthStateRecord> } {
  const data = new Map<string, OAuthStateRecord>();
  return {
    _data: data,
    async set(key, record) {
      data.set(key, record);
    },
    async get(key) {
      return data.get(key) ?? null;
    },
    async delete(key) {
      data.delete(key);
    },
  };
}

// Patches global fetch for the duration of a single test. Tests that
// don't fetch leave it alone.
function withFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const orig = globalThis.fetch;
  globalThis.fetch = impl;
  return fn().finally(() => {
    globalThis.fetch = orig;
  });
}

describe("initiateIntegrationOAuth", () => {
  let store: ReturnType<typeof memoryStore>;

  beforeEach(() => {
    store = memoryStore();
  });

  it("returns an authorize URL with PKCE S256 and the requested scopes", async () => {
    const result = await initiateIntegrationOAuth(store, {
      packageId: "@official/gmail",
      authKey: "primary",
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      clientId: "abc.apps.googleusercontent.com",
      clientSecret: "secret",
      scopes: ["openid", "email", "https://www.googleapis.com/auth/gmail.readonly"],
      redirectUri: "http://localhost:3000/api/integrations/callback",
      orgId: "org_1",
      applicationId: "app_1",
      actor: { type: "user", id: "u_1" },
    });
    const url = new URL(result.authUrl);
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("client_id")).toBe("abc.apps.googleusercontent.com");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("scope")).toBe(
      "openid email https://www.googleapis.com/auth/gmail.readonly",
    );
    expect(url.searchParams.get("state")).toBe(result.state);
  });

  it("preserves the integration discriminator in the persisted state record", async () => {
    const { state } = await initiateIntegrationOAuth(store, {
      packageId: "@org/widget",
      authKey: "github",
      authorizationUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      clientId: "Iv1.x",
      clientSecret: "x",
      redirectUri: "http://localhost:3000/cb",
      orgId: "o",
      applicationId: "a",
      actor: { type: "user", id: "u" },
    });
    const stored = await store.get(state);
    expect(stored).not.toBeNull();
    expect(stored?.integration?.packageId).toBe("@org/widget");
    expect(stored?.integration?.authKey).toBe("github");
    expect(stored?.providerId).toBe("__integration__:@org/widget:github");
  });

  it("emits the RFC 8707 `resource` parameter when the auth declares an audience", async () => {
    const result = await initiateIntegrationOAuth(store, {
      packageId: "@official/mcp",
      authKey: "primary",
      authorizationUrl: "https://idp.example.com/authorize",
      tokenUrl: "https://idp.example.com/token",
      clientId: "client",
      clientSecret: "secret",
      audience: "https://api.example.com",
      redirectUri: "http://localhost:3000/cb",
      orgId: "o",
      applicationId: "a",
      actor: { type: "user", id: "u" },
    });
    expect(new URL(result.authUrl).searchParams.get("resource")).toBe("https://api.example.com");
  });

  it("appends with `&` when the authorization URL already has a query string", async () => {
    const result = await initiateIntegrationOAuth(store, {
      packageId: "@org/x",
      authKey: "a",
      authorizationUrl: "https://idp.example.com/authorize?prompt=consent",
      tokenUrl: "https://idp.example.com/token",
      clientId: "c",
      clientSecret: "s",
      redirectUri: "http://localhost:3000/cb",
      orgId: "o",
      applicationId: "a",
      actor: { type: "user", id: "u" },
    });
    expect(result.authUrl).toContain("prompt=consent&client_id=");
    const url = new URL(result.authUrl);
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("client_id")).toBe("c");
  });

  it("merges authorizationParams into the authorize URL (e.g. Google access_type=offline)", async () => {
    const result = await initiateIntegrationOAuth(store, {
      packageId: "@official/google-drive",
      authKey: "primary",
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      clientId: "abc.apps.googleusercontent.com",
      clientSecret: "secret",
      authorizationParams: { access_type: "offline", prompt: "consent" },
      redirectUri: "http://localhost:3000/cb",
      orgId: "o",
      applicationId: "a",
      actor: { type: "user", id: "u" },
    });
    const url = new URL(result.authUrl);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
  });

  it("lets authorizationParams override the dynamic forceAccountSelect prompt", async () => {
    const result = await initiateIntegrationOAuth(store, {
      packageId: "@official/google-drive",
      authKey: "primary",
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      clientId: "c",
      clientSecret: "s",
      authorizationParams: { access_type: "offline", prompt: "consent" },
      forceAccountSelect: true,
      redirectUri: "http://localhost:3000/cb",
      orgId: "o",
      applicationId: "a",
      actor: { type: "user", id: "u" },
    });
    // Manifest authorizationParams is merged last → its `prompt=consent` wins
    // over forceAccountSelect's `prompt=select_account`, so Google still
    // re-issues a refresh_token on re-consent.
    expect(new URL(result.authUrl).searchParams.get("prompt")).toBe("consent");
  });

  it("captures end_user actor", async () => {
    const { state } = await initiateIntegrationOAuth(store, {
      packageId: "@x/y",
      authKey: "a",
      authorizationUrl: "https://idp/authorize",
      tokenUrl: "https://idp/token",
      clientId: "c",
      clientSecret: "s",
      redirectUri: "http://localhost:3000/cb",
      orgId: "o",
      applicationId: "a",
      actor: { type: "end_user", id: "eu_1" },
    });
    const stored = await store.get(state);
    expect(stored?.userId).toBeNull();
    expect(stored?.endUserId).toBe("eu_1");
  });
});

describe("handleIntegrationOAuthCallback", () => {
  let store: ReturnType<typeof memoryStore>;

  beforeEach(() => {
    store = memoryStore();
  });

  async function seedState(overrides?: Partial<Parameters<typeof initiateIntegrationOAuth>[1]>) {
    return initiateIntegrationOAuth(store, {
      packageId: "@official/gmail",
      authKey: "primary",
      authorizationUrl: "https://idp/authorize",
      tokenUrl: "https://idp/token",
      clientId: "client-id",
      clientSecret: "client-secret",
      scopes: ["openid", "email"],
      redirectUri: "http://localhost:3000/cb",
      orgId: "org_1",
      applicationId: "app_1",
      actor: { type: "user", id: "u_1" },
      ...overrides,
    });
  }

  it("exchanges the code, deletes state, and returns the parsed token shape", async () => {
    const { state } = await seedState();
    let captured: { url: string; body: string; headers: Record<string, string> } | null = null;
    const stubFetch = (async (input: Request | URL | string, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const body = init?.body ? String(init.body) : "";
      const headers: Record<string, string> = {};
      if (init?.headers instanceof Headers) {
        init.headers.forEach((v, k) => (headers[k] = v));
      } else if (init?.headers) {
        Object.assign(headers, init.headers as Record<string, string>);
      }
      captured = { url, body, headers };
      return new Response(
        JSON.stringify({
          access_token: "AT",
          refresh_token: "RT",
          expires_in: 3600,
          scope: "openid email",
          token_type: "Bearer",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const result = await withFetch(stubFetch, () =>
      handleIntegrationOAuthCallback(store, "AUTH_CODE", state),
    );

    expect(captured).not.toBeNull();
    expect(captured!.url).toBe("https://idp/token");
    const params = new URLSearchParams(captured!.body);
    expect(params.get("grant_type")).toBe("authorization_code");
    expect(params.get("code")).toBe("AUTH_CODE");
    expect(params.get("redirect_uri")).toBe("http://localhost:3000/cb");
    expect(params.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(params.get("client_id")).toBe("client-id");
    expect(params.get("client_secret")).toBe("client-secret");

    expect(result.packageId).toBe("@official/gmail");
    expect(result.authKey).toBe("primary");
    expect(result.accessToken).toBe("AT");
    expect(result.refreshToken).toBe("RT");
    expect(result.scopesGranted).toEqual(["openid", "email"]);
    expect(result.scopeShortfall).toEqual([]);
    expect(result.scopeCreep).toEqual([]);
    expect(result.actor).toEqual({ type: "user", id: "u_1" });

    // State row is consumed
    expect(await store.get(state)).toBeNull();
  });

  it("uses Basic auth when tokenAuthMethod=client_secret_basic", async () => {
    const { state } = await seedState({ tokenAuthMethod: "client_secret_basic" });
    let captured: { headers: Record<string, string>; body: string } | null = null;
    const stub = (async (_input: unknown, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      if (init?.headers instanceof Headers) {
        init.headers.forEach((v, k) => (headers[k] = v));
      } else if (init?.headers) {
        Object.assign(headers, init.headers as Record<string, string>);
      }
      captured = { headers, body: init?.body ? String(init.body) : "" };
      return new Response(
        JSON.stringify({ access_token: "AT", expires_in: 60, token_type: "Bearer" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    await withFetch(stub, () => handleIntegrationOAuthCallback(store, "CODE", state));
    const authHeader = captured!.headers["Authorization"] ?? captured!.headers["authorization"];
    expect(authHeader?.startsWith("Basic ")).toBe(true);
    const params = new URLSearchParams(captured!.body);
    expect(params.get("client_id")).toBeNull();
    expect(params.get("client_secret")).toBeNull();
  });

  it("omits client_secret and sends client_id in the body for public clients", async () => {
    const { state } = await seedState({ tokenAuthMethod: "none", clientSecret: "" });
    let body = "";
    const stub = (async (_input: unknown, init?: RequestInit) => {
      body = init?.body ? String(init.body) : "";
      return new Response(
        JSON.stringify({ access_token: "AT", expires_in: 60, token_type: "Bearer" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    await withFetch(stub, () => handleIntegrationOAuthCallback(store, "CODE", state));
    const params = new URLSearchParams(body);
    expect(params.get("client_id")).toBe("client-id");
    expect(params.get("client_secret")).toBeNull();
    expect(params.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("emits the RFC 8707 `resource` parameter on the token request when audience set", async () => {
    const { state } = await seedState({ audience: "https://api.example.com" });
    let body = "";
    const stub = (async (_input: unknown, init?: RequestInit) => {
      body = init?.body ? String(init.body) : "";
      return new Response(
        JSON.stringify({ access_token: "AT", expires_in: 60, token_type: "Bearer" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    await withFetch(stub, () => handleIntegrationOAuthCallback(store, "CODE", state));
    expect(new URLSearchParams(body).get("resource")).toBe("https://api.example.com");
  });

  it("classifies invalid_grant as `revoked` and drops the state row", async () => {
    const { state } = await seedState();
    const stub = (async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;

    let err: unknown = null;
    await withFetch(stub, async () => {
      try {
        await handleIntegrationOAuthCallback(store, "CODE", state);
      } catch (e) {
        err = e;
      }
    });
    expect(err).toBeInstanceOf(OAuthCallbackError);
    expect((err as OAuthCallbackError).kind).toBe("revoked");
    expect(await store.get(state)).toBeNull();
  });

  it("classifies other 4xx as `transient` and preserves the state row for retry", async () => {
    const { state } = await seedState();
    const stub = (async () =>
      new Response(JSON.stringify({ error: "server_error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;

    let err: unknown = null;
    await withFetch(stub, async () => {
      try {
        await handleIntegrationOAuthCallback(store, "CODE", state);
      } catch (e) {
        err = e;
      }
    });
    expect(err).toBeInstanceOf(OAuthCallbackError);
    expect((err as OAuthCallbackError).kind).toBe("transient");
    // State preserved on transient — operator may retry.
    expect(await store.get(state)).not.toBeNull();
  });

  it("rejects missing state with a structured `transient` error", async () => {
    let err: unknown = null;
    try {
      await handleIntegrationOAuthCallback(store, "CODE", "missing-state-key");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(OAuthCallbackError);
    expect((err as OAuthCallbackError).kind).toBe("transient");
  });

  it("rejects when the state record exists but is not an integration state", async () => {
    const record: OAuthStateRecord = {
      state: "S",
      orgId: "o",
      userId: "u",
      applicationId: "a",
      providerId: "@official/gmail",
      codeVerifier: "v",
      scopesRequested: [],
      redirectUri: "http://localhost/cb",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    await store.set("S", record, 60);
    let err: unknown = null;
    try {
      await handleIntegrationOAuthCallback(store, "CODE", "S");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(OAuthCallbackError);
    expect((err as OAuthCallbackError).providerId).toBe("@official/gmail");
  });

  it("flags scope shortfall when the IdP returns fewer scopes than requested", async () => {
    const { state } = await seedState({ scopes: ["openid", "email", "profile"] });
    const stub = (async () =>
      new Response(
        JSON.stringify({
          access_token: "AT",
          expires_in: 60,
          token_type: "Bearer",
          scope: "openid email",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;

    const result = await withFetch(stub, () =>
      handleIntegrationOAuthCallback(store, "CODE", state),
    );
    expect(result.scopesGranted).toEqual(["openid", "email"]);
    expect(result.scopeShortfall).toEqual(["profile"]);
  });
});
