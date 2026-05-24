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
  tokenUrl: "https://idp.example.com/token",
  clientId: "client-id",
  clientSecret: "client-secret",
  tokenAuthMethod: "client_secret_post",
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
