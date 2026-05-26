// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { performRefreshTokenExchange, RefreshError } from "../src/token-refresh.ts";
import type { RefreshContext } from "../src/token-refresh.ts";

// The SUT calls the global `fetch`; patch it for the duration of one call,
// mirroring integration-oauth.test.ts's withFetch seam.
function withFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const orig = globalThis.fetch;
  globalThis.fetch = impl;
  return fn().finally(() => {
    globalThis.fetch = orig;
  });
}

const ctx: RefreshContext = {
  tokenEndpoint: "https://idp.example.com/token",
  clientId: "client-id",
  clientSecret: "client-secret",
  tokenEndpointAuthMethod: "client_secret_post",
};

function responding(makeResponse: () => Response | Promise<Response>): typeof fetch {
  return (async () => makeResponse()) as unknown as typeof fetch;
}

async function captureError(stub: typeof fetch): Promise<unknown> {
  let err: unknown = null;
  await withFetch(stub, async () => {
    try {
      await performRefreshTokenExchange(ctx, "rt_abc", { label: "refresh" });
    } catch (e) {
      err = e;
    }
  });
  return err;
}

describe("performRefreshTokenExchange — token_endpoint_auth_method default (R8b N-3)", () => {
  it("defaults undefined tokenEndpointAuthMethod to client_secret_basic (RFC 8414/7591)", async () => {
    // AFPS 2.0.1+ default for `token_endpoint_auth_method` is
    // `client_secret_basic`. When the manifest omits the field, the refresh
    // wire MUST send credentials via the Authorization header (Basic auth),
    // NOT via the body — matching Anthropic/Google/GitHub/Slack expectations.
    let capturedHeaders: Headers | undefined;
    let capturedBody: string | undefined;
    const ctxWithoutMethod: RefreshContext = {
      tokenEndpoint: "https://idp.example.com/token",
      clientId: "my-client-id",
      clientSecret: "my-client-secret",
      // tokenEndpointAuthMethod intentionally omitted
    };
    await withFetch(
      (async (_url, init) => {
        capturedHeaders = new Headers(init?.headers as HeadersInit);
        capturedBody = init?.body as string;
        return new Response(JSON.stringify({ access_token: "new", token_type: "Bearer" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch,
      () => performRefreshTokenExchange(ctxWithoutMethod, "rt_abc", { label: "refresh" }),
    );
    // Authorization: Basic <base64(client_id:client_secret)>
    expect(capturedHeaders?.get("Authorization")).toMatch(/^Basic /);
    // Body MUST NOT carry client_id / client_secret when using Basic auth.
    expect(capturedBody).not.toContain("client_id=");
    expect(capturedBody).not.toContain("client_secret=");
  });

  it("explicit client_secret_post overrides the default", async () => {
    let capturedHeaders: Headers | undefined;
    let capturedBody: string | undefined;
    const ctxPost: RefreshContext = {
      tokenEndpoint: "https://idp.example.com/token",
      clientId: "my-client-id",
      clientSecret: "my-client-secret",
      tokenEndpointAuthMethod: "client_secret_post",
    };
    await withFetch(
      (async (_url, init) => {
        capturedHeaders = new Headers(init?.headers as HeadersInit);
        capturedBody = init?.body as string;
        return new Response(JSON.stringify({ access_token: "new", token_type: "Bearer" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch,
      () => performRefreshTokenExchange(ctxPost, "rt_abc", { label: "refresh" }),
    );
    expect(capturedHeaders?.get("Authorization")).toBeNull();
    expect(capturedBody).toContain("client_id=my-client-id");
    expect(capturedBody).toContain("client_secret=my-client-secret");
  });
});

describe("performRefreshTokenExchange — failure classification", () => {
  it("classifies HTTP 400 invalid_grant as revoked", async () => {
    const err = await captureError(
      responding(
        () =>
          new Response(JSON.stringify({ error: "invalid_grant" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
    expect(err).toBeInstanceOf(RefreshError);
    expect((err as RefreshError).kind).toBe("revoked");
    expect((err as RefreshError).status).toBe(400);
  });

  it("classifies HTTP 5xx as transient", async () => {
    const err = await captureError(
      responding(
        () =>
          new Response(JSON.stringify({ error: "server_error" }), {
            status: 503,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
    expect(err).toBeInstanceOf(RefreshError);
    expect((err as RefreshError).kind).toBe("transient");
  });

  it("classifies a network throw as transient", async () => {
    const err = await captureError((async () => {
      throw new TypeError("ConnectionRefused");
    }) as unknown as typeof fetch);
    expect(err).toBeInstanceOf(RefreshError);
    expect((err as RefreshError).kind).toBe("transient");
  });

  it("classifies a malformed/non-JSON 400 body as transient (NOT revoked)", async () => {
    const err = await captureError(
      responding(
        () =>
          new Response("<html>Bad Request</html>", {
            status: 400,
            headers: { "Content-Type": "text/html" },
          }),
      ),
    );
    expect(err).toBeInstanceOf(RefreshError);
    // A 400 we cannot parse as `{error:"invalid_grant"}` must not be
    // treated as a dead refresh token — that would force a needless reconnect.
    expect((err as RefreshError).kind).toBe("transient");
  });
});
