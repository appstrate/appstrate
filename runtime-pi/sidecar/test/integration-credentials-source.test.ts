// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the Phase 1.5 platform-backed `MitmCredentialSource`
 * factory. Covers:
 *
 *   - Initial payload is exposed verbatim via `current()` /
 *     `deliveryPlans()`.
 *   - `refreshOnUnauthorized()` POSTs to the right URL with the right
 *     Authorization header, then swaps in the response payload so the
 *     listener sees the new credentials on the NEXT request.
 *   - 403 (refresh token revoked) yields `false` and arms the cooldown
 *     so subsequent attempts back off.
 *   - 5xx / fetch failure yields `false` without crashing.
 *   - Cooldown suppresses bursts; in-flight dedup coalesces parallel
 *     refresh calls.
 *   - The boot-time `fetchInitialIntegrationCredentials` helper
 *     surfaces the body on success and the platform's `detail` on
 *     failure.
 */

import { describe, it, expect } from "bun:test";
import {
  createIntegrationCredentialsSource,
  fetchInitialIntegrationCredentials,
  type IntegrationCredentialsWire,
} from "../integration-credentials-source.ts";

function makePayload(token: string): IntegrationCredentialsWire {
  return {
    auths: [
      {
        authKey: "primary",
        authType: "api_key",
        fields: { apiKey: token },
        authorizedUris: ["https://api.test.appstrate.dev/**"],
      },
    ],
    deliveryPlans: {
      primary: {
        headerName: "X-Test-Token",
        headerPrefix: "",
        value: token,
        allowServerOverride: false,
      },
    },
    expiresAtEpochMs: { primary: null },
  };
}

describe("createIntegrationCredentialsSource", () => {
  it("exposes the initial payload via current() and deliveryPlans()", () => {
    const initial = makePayload("tok-1");
    const fetchFn = (async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    const source = createIntegrationCredentialsSource({
      packageId: "@test/integ",
      platformApiUrl: "http://api",
      runToken: "run-tok",
      initialPayload: initial,
      fetchFn,
    });
    const cur = source.current();
    expect(cur.auths.length).toBe(1);
    expect(cur.auths[0]!.fields.apiKey).toBe("tok-1");
    expect(source.deliveryPlans().primary?.value).toBe("tok-1");
  });

  it("POSTs to /refresh with bearer token and swaps in the new payload", async () => {
    const initial = makePayload("tok-1");
    const calls: Array<{ url: string; headers: Record<string, string>; method: string }> = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      const headers: Record<string, string> = {};
      const rawHeaders = init.headers as Record<string, string> | undefined;
      if (rawHeaders) {
        for (const [k, v] of Object.entries(rawHeaders)) headers[k] = v;
      }
      calls.push({ url, headers, method: init.method ?? "GET" });
      return new Response(JSON.stringify(makePayload("tok-2")), { status: 200 });
    }) as unknown as typeof fetch;

    const source = createIntegrationCredentialsSource({
      packageId: "@test/integ",
      platformApiUrl: "http://api",
      runToken: "run-tok",
      initialPayload: initial,
      fetchFn,
    });

    expect(source.current().auths[0]!.fields.apiKey).toBe("tok-1");
    const ok = await source.refreshOnUnauthorized("primary");
    expect(ok).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe("http://api/internal/integration-credentials/@test/integ/refresh");
    expect(calls[0]!.headers.Authorization).toBe("Bearer run-tok");
    expect(source.current().auths[0]!.fields.apiKey).toBe("tok-2");
    expect(source.deliveryPlans().primary?.value).toBe("tok-2");
  });

  it("returns false on 403 (revoked) and arms the cooldown", async () => {
    const initial = makePayload("tok-1");
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      return new Response("", { status: 403 });
    }) as unknown as typeof fetch;

    const source = createIntegrationCredentialsSource({
      packageId: "@test/integ",
      platformApiUrl: "http://api",
      runToken: "run-tok",
      initialPayload: initial,
      fetchFn,
      minRefreshIntervalMs: 60_000,
    });

    expect(await source.refreshOnUnauthorized("primary")).toBe(false);
    // Cooldown should suppress the second attempt without firing fetch.
    expect(await source.refreshOnUnauthorized("primary")).toBe(false);
    expect(calls).toBe(1);
  });

  it("returns false on fetch network failure without crashing", async () => {
    const initial = makePayload("tok-1");
    const fetchFn = (async () => {
      throw new TypeError("ConnectionRefused");
    }) as unknown as typeof fetch;
    const source = createIntegrationCredentialsSource({
      packageId: "@test/integ",
      platformApiUrl: "http://api",
      runToken: "run-tok",
      initialPayload: initial,
      fetchFn,
    });
    expect(await source.refreshOnUnauthorized("primary")).toBe(false);
    // Payload unchanged.
    expect(source.current().auths[0]!.fields.apiKey).toBe("tok-1");
  });

  it("returns false on non-OK non-403 status", async () => {
    const initial = makePayload("tok-1");
    const fetchFn = (async () =>
      new Response("upstream broke", { status: 502 })) as unknown as typeof fetch;
    const source = createIntegrationCredentialsSource({
      packageId: "@test/integ",
      platformApiUrl: "http://api",
      runToken: "run-tok",
      initialPayload: initial,
      fetchFn,
    });
    expect(await source.refreshOnUnauthorized("primary")).toBe(false);
  });

  it("coalesces concurrent refresh calls for the same authKey", async () => {
    const initial = makePayload("tok-1");
    let calls = 0;
    let resolvePending: ((value: Response) => void) | null = null;
    const pending = new Promise<Response>((resolve) => {
      resolvePending = resolve;
    });
    const fetchFn = (async () => {
      calls += 1;
      return pending;
    }) as unknown as typeof fetch;

    const source = createIntegrationCredentialsSource({
      packageId: "@test/integ",
      platformApiUrl: "http://api",
      runToken: "run-tok",
      initialPayload: initial,
      fetchFn,
    });

    // Three concurrent refresh calls — should fire ONE network call.
    const p1 = source.refreshOnUnauthorized("primary");
    const p2 = source.refreshOnUnauthorized("primary");
    const p3 = source.refreshOnUnauthorized("primary");
    expect(calls).toBe(1);
    resolvePending!(new Response(JSON.stringify(makePayload("tok-2")), { status: 200 }));
    expect(await p1).toBe(true);
    expect(await p2).toBe(true);
    expect(await p3).toBe(true);
    expect(calls).toBe(1);
  });

  it("returns false on malformed JSON without leaving stale in-flight state", async () => {
    const initial = makePayload("tok-1");
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      return new Response("not json", { status: 200 });
    }) as unknown as typeof fetch;

    const source = createIntegrationCredentialsSource({
      packageId: "@test/integ",
      platformApiUrl: "http://api",
      runToken: "run-tok",
      initialPayload: initial,
      fetchFn,
      // Avoid cooldown blocking the second attempt.
      minRefreshIntervalMs: 0,
    });

    expect(await source.refreshOnUnauthorized("primary")).toBe(false);
    expect(await source.refreshOnUnauthorized("primary")).toBe(false);
    expect(calls).toBe(2);
  });
});

describe("fetchInitialIntegrationCredentials", () => {
  it("GETs the right URL with the bearer and returns the body", async () => {
    const payload = makePayload("tok-x");
    const seen: { url?: string; auth?: string } = {};
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen.url = url;
      const headers = init.headers as Record<string, string> | undefined;
      seen.auth = headers?.Authorization;
      return new Response(JSON.stringify(payload), { status: 200 });
    }) as unknown as typeof fetch;
    const out = await fetchInitialIntegrationCredentials("@scope/name", {
      platformApiUrl: "http://api",
      runToken: "tok",
      fetchFn,
    });
    expect(seen.url).toBe("http://api/internal/integration-credentials/@scope/name");
    expect(seen.auth).toBe("Bearer tok");
    expect(out.auths[0]!.fields.apiKey).toBe("tok-x");
  });

  it("surfaces the platform's `detail` on HTTP failure", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ detail: "Integration not installed" }), {
        status: 404,
      })) as unknown as typeof fetch;
    await expect(
      fetchInitialIntegrationCredentials("@scope/name", {
        platformApiUrl: "http://api",
        runToken: "tok",
        fetchFn,
      }),
    ).rejects.toThrow("Integration not installed");
  });

  it("falls back to a generic message when the body isn't structured", async () => {
    const fetchFn = (async () => new Response("oops", { status: 500 })) as unknown as typeof fetch;
    await expect(
      fetchInitialIntegrationCredentials("@scope/name", {
        platformApiUrl: "http://api",
        runToken: "tok",
        fetchFn,
      }),
    ).rejects.toThrow("HTTP 500");
  });
});
