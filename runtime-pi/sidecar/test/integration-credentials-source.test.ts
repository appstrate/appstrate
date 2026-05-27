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
 *   - 410 (refresh token revoked) yields `false` and arms the cooldown
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

/**
 * Build the snake_case JSON shape the platform emits over the wire (per AFPS).
 * The sidecar's `normalizeIntegrationCredentialsWire` is the
 * deserialization boundary that flips these snake_case keys back to the TS
 * camelCase `IntegrationCredentialsWire` shape — tests must mock the wire,
 * not the TS shape.
 */
function makeWireJson(token: string): Record<string, unknown> {
  return {
    auths: [
      {
        auth_key: "primary",
        auth_type: "api_key",
        fields: { apiKey: token },
        authorized_uris: ["https://api.test.appstrate.dev/**"],
      },
    ],
    delivery_plans: {
      primary: {
        header_name: "X-Test-Token",
        header_prefix: "",
        value: token,
        allow_server_override: false,
      },
    },
    expires_at_epoch_ms: { primary: null },
  };
}

describe("createIntegrationCredentialsSource", () => {
  it("exposes the initial payload via current() and deliveryPlans()", () => {
    const initial = makePayload("tok-1");
    const fetchFn = (async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    const source = createIntegrationCredentialsSource({
      integrationId: "@test/integ",
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
      return new Response(JSON.stringify(makeWireJson("tok-2")), { status: 200 });
    }) as unknown as typeof fetch;

    const source = createIntegrationCredentialsSource({
      integrationId: "@test/integ",
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

  it("returns false on 410 (revoked) and arms the cooldown", async () => {
    const initial = makePayload("tok-1");
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      return new Response("", { status: 410 });
    }) as unknown as typeof fetch;

    const source = createIntegrationCredentialsSource({
      integrationId: "@test/integ",
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
      integrationId: "@test/integ",
      platformApiUrl: "http://api",
      runToken: "run-tok",
      initialPayload: initial,
      fetchFn,
    });
    expect(await source.refreshOnUnauthorized("primary")).toBe(false);
    // Payload unchanged.
    expect(source.current().auths[0]!.fields.apiKey).toBe("tok-1");
  });

  it("returns false on non-OK non-410 status", async () => {
    const initial = makePayload("tok-1");
    const fetchFn = (async () =>
      new Response("upstream broke", { status: 502 })) as unknown as typeof fetch;
    const source = createIntegrationCredentialsSource({
      integrationId: "@test/integ",
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
      integrationId: "@test/integ",
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
    resolvePending!(new Response(JSON.stringify(makeWireJson("tok-2")), { status: 200 }));
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
      integrationId: "@test/integ",
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

describe("createIntegrationCredentialsSource — connect.tool re-login (P3)", () => {
  it("shouldReauth is true only for a registered authKey + declared status", () => {
    const source = createIntegrationCredentialsSource({
      integrationId: "@test/integ",
      platformApiUrl: "http://api",
      runToken: "run-tok",
      initialPayload: makePayload("tok-1"),
      fetchFn: (async () => new Response("", { status: 500 })) as unknown as typeof fetch,
    });
    // Nothing registered yet → always false.
    expect(source.shouldReauth("primary", 401)).toBe(false);

    source.setReloginHandler("primary", async () => true, [401, 419]);
    expect(source.shouldReauth("primary", 401)).toBe(true);
    expect(source.shouldReauth("primary", 419)).toBe(true);
    // Status not in the declared set → false.
    expect(source.shouldReauth("primary", 403)).toBe(false);
    // Unregistered authKey → false.
    expect(source.shouldReauth("other", 401)).toBe(false);
  });

  it("refreshOnUnauthorized routes to the re-login handler (NOT the platform POST)", async () => {
    let postCalls = 0;
    const fetchFn = (async () => {
      postCalls += 1;
      return new Response(JSON.stringify(makeWireJson("tok-platform")), { status: 200 });
    }) as unknown as typeof fetch;
    const source = createIntegrationCredentialsSource({
      integrationId: "@test/integ",
      platformApiUrl: "http://api",
      runToken: "run-tok",
      initialPayload: makePayload("tok-1"),
      fetchFn,
    });

    let handlerRan = 0;
    source.setReloginHandler(
      "primary",
      async () => {
        handlerRan += 1;
        return true;
      },
      [401],
    );

    const ok = await source.refreshOnUnauthorized("primary");
    expect(ok).toBe(true);
    expect(handlerRan).toBe(1);
    // The platform refresh endpoint must NOT have been called.
    expect(postCalls).toBe(0);
  });

  it("still POSTs the platform when no re-login handler is registered", async () => {
    let postCalls = 0;
    const fetchFn = (async () => {
      postCalls += 1;
      return new Response(JSON.stringify(makeWireJson("tok-2")), { status: 200 });
    }) as unknown as typeof fetch;
    const source = createIntegrationCredentialsSource({
      integrationId: "@test/integ",
      platformApiUrl: "http://api",
      runToken: "run-tok",
      initialPayload: makePayload("tok-1"),
      fetchFn,
    });
    // Handler registered for a DIFFERENT authKey — primary still uses POST.
    source.setReloginHandler("other", async () => true, [401]);

    expect(await source.refreshOnUnauthorized("primary")).toBe(true);
    expect(postCalls).toBe(1);
    expect(source.current().auths[0]!.fields.apiKey).toBe("tok-2");
  });

  it("applies cooldown + in-flight dedup to the re-login path", async () => {
    const source = createIntegrationCredentialsSource({
      integrationId: "@test/integ",
      platformApiUrl: "http://api",
      runToken: "run-tok",
      initialPayload: makePayload("tok-1"),
      fetchFn: (async () => new Response("", { status: 500 })) as unknown as typeof fetch,
      minRefreshIntervalMs: 60_000,
    });

    let handlerRan = 0;
    let resolvePending: ((v: boolean) => void) | null = null;
    const pending = new Promise<boolean>((resolve) => {
      resolvePending = resolve;
    });
    source.setReloginHandler(
      "primary",
      () => {
        handlerRan += 1;
        return pending;
      },
      [401],
    );

    // In-flight dedup: two concurrent calls run the handler once.
    const p1 = source.refreshOnUnauthorized("primary");
    const p2 = source.refreshOnUnauthorized("primary");
    expect(handlerRan).toBe(1);
    resolvePending!(true);
    expect(await p1).toBe(true);
    expect(await p2).toBe(true);

    // Cooldown: a subsequent call within the interval is suppressed without
    // re-running the handler.
    expect(await source.refreshOnUnauthorized("primary")).toBe(false);
    expect(handlerRan).toBe(1);
  });

  it("returns false (and arms cooldown) when the re-login handler throws", async () => {
    const source = createIntegrationCredentialsSource({
      integrationId: "@test/integ",
      platformApiUrl: "http://api",
      runToken: "run-tok",
      initialPayload: makePayload("tok-1"),
      fetchFn: (async () => new Response("", { status: 500 })) as unknown as typeof fetch,
      minRefreshIntervalMs: 60_000,
    });
    let handlerRan = 0;
    source.setReloginHandler(
      "primary",
      async () => {
        handlerRan += 1;
        throw new Error("login tool exploded");
      },
      [401],
    );
    expect(await source.refreshOnUnauthorized("primary")).toBe(false);
    // Cooldown armed → second attempt suppressed.
    expect(await source.refreshOnUnauthorized("primary")).toBe(false);
    expect(handlerRan).toBe(1);
  });
});

describe("fetchInitialIntegrationCredentials", () => {
  it("GETs the right URL with the bearer and returns the body", async () => {
    const payload = makeWireJson("tok-x");
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
