// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { exchangeAuthorizationCode } from "../src/token-exchange.ts";
import { OAuthCallbackError } from "../src/oauth.ts";
import type { OAuthStateRecord, OAuthStateStore } from "../src/types.ts";

// Mirrors integration-oauth.test.ts: patch global fetch for the duration of
// a single call, restore afterwards. The SUT calls the global `fetch`, so
// this is the established injection seam — no production change needed.
function withFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const orig = globalThis.fetch;
  globalThis.fetch = impl;
  return fn().finally(() => {
    globalThis.fetch = orig;
  });
}

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

interface Captured {
  url: string;
  body: string;
  headers: Record<string, string>;
}

// Returns a stub fetch plus a `captured` ref that the assertions read after.
function recordingFetch(response: Response): {
  fetch: typeof fetch;
  captured: { value: Captured | null };
} {
  const captured: { value: Captured | null } = { value: null };
  const stub = (async (input: Request | URL | string, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers: Record<string, string> = {};
    if (init?.headers instanceof Headers) {
      init.headers.forEach((v, k) => (headers[k] = v));
    } else if (init?.headers) {
      Object.assign(headers, init.headers as Record<string, string>);
    }
    captured.value = { url, body: init?.body ? String(init.body) : "", headers };
    return response;
  }) as unknown as typeof fetch;
  return { fetch: stub, captured };
}

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function baseInput(
  store: OAuthStateStore,
  overrides: Partial<Parameters<typeof exchangeAuthorizationCode>[0]> = {},
): Parameters<typeof exchangeAuthorizationCode>[0] {
  return {
    tokenEndpoint: "https://idp.example.com/token",
    clientId: "client-id",
    clientSecret: "client-secret",
    tokenEndpointAuthMethod: "client_secret_post",
    codeVerifier: "verifier-123",
    redirectUri: "http://localhost:3000/cb",
    code: "AUTH_CODE",
    scopesRequested: ["openid", "email"],
    errorLabel: "@official/gmail:primary",
    state: "state-key",
    store,
    ...overrides,
  };
}

describe("exchangeAuthorizationCode — client auth method", () => {
  it("client_secret_post sends the secret in the body", async () => {
    const store = memoryStore();
    const { fetch: stub, captured } = recordingFetch(jsonResponse({ access_token: "AT" }));
    await withFetch(stub, () =>
      exchangeAuthorizationCode(
        baseInput(store, { tokenEndpointAuthMethod: "client_secret_post" }),
      ),
    );
    const params = new URLSearchParams(captured.value!.body);
    expect(params.get("client_id")).toBe("client-id");
    expect(params.get("client_secret")).toBe("client-secret");
    const authHeader =
      captured.value!.headers["Authorization"] ?? captured.value!.headers["authorization"];
    expect(authHeader).toBeUndefined();
  });

  it("client_secret_basic sends Authorization: Basic and omits the body secret", async () => {
    const store = memoryStore();
    const { fetch: stub, captured } = recordingFetch(jsonResponse({ access_token: "AT" }));
    await withFetch(stub, () =>
      exchangeAuthorizationCode(
        baseInput(store, { tokenEndpointAuthMethod: "client_secret_basic" }),
      ),
    );
    const authHeader =
      captured.value!.headers["Authorization"] ?? captured.value!.headers["authorization"];
    expect(authHeader?.startsWith("Basic ")).toBe(true);
    const decoded = Buffer.from(authHeader!.slice(6), "base64").toString();
    expect(decoded).toBe("client-id:client-secret");
    const params = new URLSearchParams(captured.value!.body);
    expect(params.get("client_id")).toBeNull();
    expect(params.get("client_secret")).toBeNull();
  });

  it("tokenEndpointAuthMethod=none (public client) omits the secret entirely", async () => {
    const store = memoryStore();
    const { fetch: stub, captured } = recordingFetch(jsonResponse({ access_token: "AT" }));
    await withFetch(stub, () =>
      exchangeAuthorizationCode(
        baseInput(store, { tokenEndpointAuthMethod: "none", clientSecret: "" }),
      ),
    );
    const authHeader =
      captured.value!.headers["Authorization"] ?? captured.value!.headers["authorization"];
    expect(authHeader).toBeUndefined();
    const params = new URLSearchParams(captured.value!.body);
    // Public clients still send the id, but never the secret.
    expect(params.get("client_id")).toBe("client-id");
    expect(params.get("client_secret")).toBeNull();
  });
});

describe("exchangeAuthorizationCode — error classification", () => {
  it("classifies HTTP 400 invalid_grant as a revoked OAuthCallbackError and deletes state", async () => {
    const store = memoryStore();
    await store.set("state-key", {} as OAuthStateRecord, 60);
    const { fetch: stub } = recordingFetch(jsonResponse({ error: "invalid_grant" }, 400));

    let err: unknown = null;
    await withFetch(stub, async () => {
      try {
        await exchangeAuthorizationCode(baseInput(store));
      } catch (e) {
        err = e;
      }
    });
    expect(err).toBeInstanceOf(OAuthCallbackError);
    const e = err as OAuthCallbackError;
    expect(e.kind).toBe("revoked");
    expect(e.oauthError).toBe("invalid_grant");
    expect(e.status).toBe(400);
    // State row consumed on revoked classification.
    expect(await store.get("state-key")).toBeNull();
  });

  it("surfaces a network throw as a transient OAuthCallbackError", async () => {
    const store = memoryStore();
    const stub = (async () => {
      throw new TypeError("ConnectionRefused");
    }) as unknown as typeof fetch;

    let err: unknown = null;
    await withFetch(stub, async () => {
      try {
        await exchangeAuthorizationCode(baseInput(store));
      } catch (e) {
        err = e;
      }
    });
    expect(err).toBeInstanceOf(OAuthCallbackError);
    expect((err as OAuthCallbackError).kind).toBe("transient");
  });

  it("throws on a non-JSON success body rather than returning garbage", async () => {
    const store = memoryStore();
    const { fetch: stub } = recordingFetch(
      new Response("<html>not json</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    );

    let err: unknown = null;
    await withFetch(stub, async () => {
      try {
        await exchangeAuthorizationCode(baseInput(store));
      } catch (e) {
        err = e;
      }
    });
    expect(err).toBeInstanceOf(OAuthCallbackError);
    expect((err as OAuthCallbackError).kind).toBe("transient");
    expect((err as OAuthCallbackError).message).toContain("non-JSON");
  });

  it("does not concatenate the raw IdP error body into the thrown message", async () => {
    const store = memoryStore();
    const MARKER = "LEAKED_CODE_abc123_should_not_appear";
    const { fetch: stub } = recordingFetch(
      jsonResponse({ error: "invalid_grant", reflected_code: MARKER }, 400),
    );

    let err: unknown = null;
    await withFetch(stub, async () => {
      try {
        await exchangeAuthorizationCode(baseInput(store));
      } catch (e) {
        err = e;
      }
    });
    expect(err).toBeInstanceOf(OAuthCallbackError);
    // The marker may live on the typed `body` field for diagnostics, but
    // must never be in the human-facing message a generic catcher logs.
    expect((err as OAuthCallbackError).message).not.toContain(MARKER);
    expect((err as OAuthCallbackError).body).toContain(MARKER);
  });
});
