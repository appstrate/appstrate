// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { performRefreshTokenExchange, RefreshError } from "../src/token-refresh.ts";
import type { RefreshContext } from "../src/token-refresh.ts";

// The SUT egress is SSRF-guarded (`oauthEgressFetch` does real DNS), so tests
// inject a stub via `ctx.fetchImpl` rather than patching the global `fetch` —
// a non-resolvable test hostname would (correctly) fail-close otherwise.
function withStub<T>(
  impl: typeof fetch,
  ctxBase: RefreshContext,
  fn: (ctx: RefreshContext) => Promise<T>,
): Promise<T> {
  return fn({ ...ctxBase, fetchImpl: impl });
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
  try {
    await performRefreshTokenExchange({ ...ctx, fetchImpl: stub }, "rt_abc", { label: "refresh" });
  } catch (e) {
    err = e;
  }
  return err;
}

describe("performRefreshTokenExchange — token_endpoint_auth_method default (R8b N-3)", () => {
  it("defaults undefined tokenEndpointAuthMethod to client_secret_basic (RFC 8414/7591)", async () => {
    // AFPS default for `token_endpoint_auth_method` is
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
    await withStub(
      (async (_url, init) => {
        capturedHeaders = new Headers(init?.headers as HeadersInit);
        capturedBody = init?.body as string;
        return new Response(JSON.stringify({ access_token: "new", token_type: "Bearer" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch,
      ctxWithoutMethod,
      (ctx) => performRefreshTokenExchange(ctx, "rt_abc", { label: "refresh" }),
    );
    // Authorization: Basic <base64(client_id:client_secret)>
    expect(capturedHeaders?.get("Authorization")).toMatch(/^Basic /);
    // Body MUST NOT carry client_id / client_secret when using Basic auth.
    expect(capturedBody).not.toContain("client_id=");
    expect(capturedBody).not.toContain("client_secret=");
  });

  it("token_endpoint_auth_method=none sends client_id in body, no secret, no Basic header (RFC 6749 §6 public client)", async () => {
    let capturedHeaders: Headers | undefined;
    let capturedBody: string | undefined;
    const ctxNone: RefreshContext = {
      tokenEndpoint: "https://idp.example.com/token",
      clientId: "public-client-id",
      clientSecret: "", // public clients carry no secret
      tokenEndpointAuthMethod: "none",
    };
    await withStub(
      (async (_url, init) => {
        capturedHeaders = new Headers(init?.headers as HeadersInit);
        capturedBody = init?.body as string;
        return new Response(JSON.stringify({ access_token: "new", token_type: "Bearer" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch,
      ctxNone,
      (ctx) => performRefreshTokenExchange(ctx, "rt_abc", { label: "refresh" }),
    );
    // No Authorization header — public clients don't carry credentials in headers.
    expect(capturedHeaders?.get("Authorization")).toBeNull();
    // client_id MUST be in the body (RFC 6749 §3.2.1).
    expect(capturedBody).toContain("client_id=public-client-id");
    // client_secret MUST NOT be in the body — there is no secret to send.
    expect(capturedBody).not.toContain("client_secret=");
    // grant_type + refresh_token are always present.
    expect(capturedBody).toContain("grant_type=refresh_token");
    expect(capturedBody).toContain("refresh_token=rt_abc");
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
    await withStub(
      (async (_url, init) => {
        capturedHeaders = new Headers(init?.headers as HeadersInit);
        capturedBody = init?.body as string;
        return new Response(JSON.stringify({ access_token: "new", token_type: "Bearer" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch,
      ctxPost,
      (ctx) => performRefreshTokenExchange(ctx, "rt_abc", { label: "refresh" }),
    );
    expect(capturedHeaders?.get("Authorization")).toBeNull();
    expect(capturedBody).toContain("client_id=my-client-id");
    expect(capturedBody).toContain("client_secret=my-client-secret");
  });

  // Same invariant as the initial exchange: refresh must not post
  // `client_secret=` either. The pair now arrives already reconciled from
  // `resolveIntegrationClientById`, so an incoherent one is a bug and is
  // refused rather than quietly downgraded.
  it("refuses client_secret_post with a BLANK secret", async () => {
    const ctxBlank: RefreshContext = {
      tokenEndpoint: "https://idp.example.com/token",
      clientId: "my-client-id",
      clientSecret: "",
      tokenEndpointAuthMethod: "client_secret_post",
    };
    let called = false;
    await expect(
      withStub(
        (async () => {
          called = true;
          return new Response("{}", { status: 200 });
        }) as unknown as typeof fetch,
        ctxBlank,
        (ctx) => performRefreshTokenExchange(ctx, "rt_abc", { label: "refresh" }),
      ),
    ).rejects.toThrow(/requires a client_secret/);
    expect(called).toBe(false);
  });

  it("refuses client_secret_basic with a BLANK secret", async () => {
    const ctxBlank: RefreshContext = {
      tokenEndpoint: "https://idp.example.com/token",
      clientId: "my-client-id",
      clientSecret: "",
      tokenEndpointAuthMethod: "client_secret_basic",
    };
    let called = false;
    await expect(
      withStub(
        (async () => {
          called = true;
          return new Response("{}", { status: 200 });
        }) as unknown as typeof fetch,
        ctxBlank,
        (ctx) => performRefreshTokenExchange(ctx, "rt_abc", { label: "refresh" }),
      ),
    ).rejects.toThrow(/requires a client_secret/);
    expect(called).toBe(false);
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

// A 2xx whose body carries no `access_token` is a FAILED refresh dressed as a
// success. It used to be absorbed: the caller's current access token was
// spliced in as a fallback, so the exchange returned "ok" while handing back
// the very token the refresh existed to replace — and the write-back then
// cleared `needsReconnection` and the failure streak on a dead credential.
describe("performRefreshTokenExchange — a 2xx without access_token is a failure", () => {
  function respondingJson(body: unknown): typeof fetch {
    return responding(
      () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
  }

  it("throws on an IdP that answers 200 with an error object", async () => {
    const err = await captureError(respondingJson({ error: "invalid_grant" }));
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).toContain("access_token");
  });

  it("throws on an empty 200 body rather than reusing the previous token", async () => {
    const err = await captureError(respondingJson({}));
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).toContain("access_token");
  });

  it("throws on a 200 that only rotates the refresh token", async () => {
    const err = await captureError(respondingJson({ refresh_token: "rt_new", expires_in: 3600 }));
    expect(err).toBeInstanceOf(Error);
  });

  // The counterpart that must KEEP working: RFC 6749 §6 lets the server omit
  // `refresh_token` to mean "keep the one you have", and non-rotating providers
  // (Google, Slack, GitHub) rely on it. Only the access-token fallback was the
  // silent substitution.
  it("still preserves the caller's refresh token when the response omits it", async () => {
    const { parsed } = await performRefreshTokenExchange(
      { ...ctx, fetchImpl: respondingJson({ access_token: "at_new", expires_in: 3600 }) },
      "rt_abc",
      { label: "refresh" },
    );
    expect(parsed.accessToken).toBe("at_new");
    expect(parsed.refreshToken).toBe("rt_abc");
  });
});
