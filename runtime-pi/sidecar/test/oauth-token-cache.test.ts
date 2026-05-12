// SPDX-License-Identifier: Apache-2.0

/**
 * Coverage for the sidecar's OAuth token cache (SPEC §5.2).
 *
 * Invariants under test:
 *   - Cache hit reuses the in-memory entry within {@link CACHE_TTL_MS}
 *     (concurrent reads = single fetch).
 *   - Proactive refresh fires when expiry falls within the lead-time
 *     window, even on a cache miss (first read of a near-expired token
 *     calls /refresh, not /token).
 *   - 50 concurrent calls to `getToken` for the same connection collapse
 *     into exactly one in-flight fetch (singleflight guarantee).
 *   - 410 from the platform surfaces as `NeedsReconnectionError`.
 *   - `invalidate()` forces the next read to round-trip.
 *   - `forceRefresh()` calls the refresh endpoint and replaces the cache.
 */

import { describe, it, expect, mock } from "bun:test";
import { OAuthTokenCache, NeedsReconnectionError, CACHE_TTL_MS } from "../oauth-token-cache.ts";
import { OAUTH_REFRESH_LEAD_MS, type OAuthTokenResponse } from "@appstrate/core/sidecar-types";

function makeTokenResponse(overrides: Partial<OAuthTokenResponse> = {}): OAuthTokenResponse {
  return {
    accessToken: "tok-fresh",
    expiresAt: Date.now() + 60 * 60_000, // 1h
    ...overrides,
  };
}

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface CacheHarness {
  cache: OAuthTokenCache;
  fetchFn: ReturnType<typeof mock>;
  calls: () => Array<{ url: string; method: string }>;
}

function makeHarness(handler?: (url: string, init: RequestInit) => Response): CacheHarness {
  const calls: Array<{ url: string; method: string }> = [];
  const fetchFn = mock(async (url: unknown, init?: RequestInit) => {
    const u = typeof url === "string" ? url : (url as URL).toString();
    calls.push({ url: u, method: init?.method ?? "GET" });
    return handler ? handler(u, init ?? {}) : makeJsonResponse(makeTokenResponse());
  });
  const cache = new OAuthTokenCache({
    getPlatformApiUrl: () => "http://platform",
    getRunToken: () => "run-tok",
    fetchFn: fetchFn as unknown as typeof fetch,
  });
  return { cache, fetchFn, calls: () => calls };
}

describe("OAuthTokenCache.getToken — basic", () => {
  it("fetches once and caches", async () => {
    const { cache, calls } = makeHarness();
    const t1 = await cache.getToken("c1");
    const t2 = await cache.getToken("c1");
    expect(t1.accessToken).toBe("tok-fresh");
    expect(t2.accessToken).toBe("tok-fresh");
    expect(calls()).toHaveLength(1);
    expect(calls()[0]?.url).toBe("http://platform/internal/oauth-token/c1");
  });

  it("returns cached entry within TTL", async () => {
    const expiresAt = Date.now() + 60 * 60_000;
    let invocations = 0;
    const { cache } = makeHarness(() => {
      invocations++;
      return makeJsonResponse(makeTokenResponse({ expiresAt, accessToken: `t${invocations}` }));
    });
    const t1 = await cache.getToken("c1");
    const t2 = await cache.getToken("c1");
    expect(t1.accessToken).toBe(t2.accessToken);
    expect(invocations).toBe(1);
  });

  it("singleflights 50 concurrent reads of the same connection", async () => {
    let inflight = 0;
    let maxInflight = 0;
    let invocations = 0;
    const { cache } = makeHarness(async () => {
      invocations++;
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      // Simulate a non-instant platform response so concurrent calls overlap
      await new Promise((r) => setTimeout(r, 5));
      inflight--;
      return makeJsonResponse(makeTokenResponse());
    });

    const promises = Array.from({ length: 50 }, () => cache.getToken("c1"));
    const results = await Promise.all(promises);
    expect(results).toHaveLength(50);
    expect(invocations).toBe(1);
    expect(maxInflight).toBe(1);
  });

  it("isolates by credentialId — different credentials fetch independently", async () => {
    let invocations = 0;
    const { cache } = makeHarness(() => {
      invocations++;
      return makeJsonResponse(makeTokenResponse({ accessToken: `tok-${invocations}` }));
    });
    const [a, b] = await Promise.all([cache.getToken("c1"), cache.getToken("c2")]);
    expect(a.accessToken).not.toBe(b.accessToken);
    expect(invocations).toBe(2);
  });
});

describe("OAuthTokenCache.getToken — proactive refresh", () => {
  it("calls /refresh when initial response shows near-expiry", async () => {
    let firstCallReturned: OAuthTokenResponse | null = null;
    const { cache, calls } = makeHarness((url) => {
      if (url.endsWith("/refresh")) {
        return makeJsonResponse(
          makeTokenResponse({
            accessToken: "tok-after-refresh",
            expiresAt: Date.now() + 60 * 60_000,
          }),
        );
      }
      firstCallReturned = makeTokenResponse({
        accessToken: "tok-near-expiry",
        // Within OAUTH_REFRESH_LEAD_MS — should trigger proactive refresh
        expiresAt: Date.now() + (OAUTH_REFRESH_LEAD_MS - 1_000),
      });
      return makeJsonResponse(firstCallReturned);
    });

    const t = await cache.getToken("c1");
    expect(t.accessToken).toBe("tok-after-refresh");
    expect(calls()).toHaveLength(2);
    expect(calls()[0]?.url).toBe("http://platform/internal/oauth-token/c1");
    expect(calls()[1]?.url).toBe("http://platform/internal/oauth-token/c1/refresh");
    expect(calls()[1]?.method).toBe("POST");
  });

  it("calls /refresh when expiresAt is null (unknown)", async () => {
    const { cache, calls } = makeHarness((url) => {
      if (url.endsWith("/refresh")) {
        return makeJsonResponse(
          makeTokenResponse({ accessToken: "tok-refresh", expiresAt: Date.now() + 60 * 60_000 }),
        );
      }
      return makeJsonResponse(makeTokenResponse({ accessToken: "tok-no-expiry", expiresAt: null }));
    });

    const t = await cache.getToken("c1");
    expect(t.accessToken).toBe("tok-refresh");
    expect(calls()).toHaveLength(2);
  });
});

describe("OAuthTokenCache — error paths", () => {
  it("throws NeedsReconnectionError on 410", async () => {
    const { cache } = makeHarness(() => makeJsonResponse({ detail: "needs reconnection" }, 410));
    await expect(cache.getToken("c1")).rejects.toThrow(NeedsReconnectionError);
  });

  it("propagates platform error detail on non-2xx", async () => {
    const { cache } = makeHarness(() =>
      makeJsonResponse({ detail: "boom: connection corrupted" }, 500),
    );
    await expect(cache.getToken("c1")).rejects.toThrow(/boom: connection corrupted/);
  });

  it("falls back to a generic error when platform response has no detail", async () => {
    const { cache } = makeHarness(() => new Response("", { status: 503 }));
    await expect(cache.getToken("c1")).rejects.toThrow(/503/);
  });
});

describe("OAuthTokenCache — invalidation", () => {
  it("invalidate() forces next read to round-trip", async () => {
    let invocations = 0;
    const { cache } = makeHarness(() => {
      invocations++;
      return makeJsonResponse(makeTokenResponse({ accessToken: `tok-${invocations}` }));
    });
    const t1 = await cache.getToken("c1");
    cache.invalidate("c1");
    const t2 = await cache.getToken("c1");
    expect(t1.accessToken).toBe("tok-1");
    expect(t2.accessToken).toBe("tok-2");
    expect(invocations).toBe(2);
  });

  it("forceRefresh() calls /refresh and replaces the cache", async () => {
    let invocations = 0;
    const { cache, calls } = makeHarness((url) => {
      invocations++;
      const isRefresh = url.endsWith("/refresh");
      return makeJsonResponse(
        makeTokenResponse({ accessToken: isRefresh ? "tok-after" : "tok-before" }),
      );
    });
    const t1 = await cache.getToken("c1");
    expect(t1.accessToken).toBe("tok-before");
    const t2 = await cache.forceRefresh("c1");
    expect(t2.accessToken).toBe("tok-after");
    // Subsequent getToken returns the refreshed entry without a new fetch
    const t3 = await cache.getToken("c1");
    expect(t3.accessToken).toBe("tok-after");
    expect(invocations).toBe(2);
    expect(calls()[1]?.method).toBe("POST");
  });

  it("forceRefresh() singleflights with concurrent reads", async () => {
    let invocations = 0;
    const { cache } = makeHarness(async () => {
      invocations++;
      await new Promise((r) => setTimeout(r, 5));
      return makeJsonResponse(makeTokenResponse());
    });
    // Force a read in flight, then call forceRefresh — should join the inflight
    const [r1, r2] = await Promise.all([cache.getToken("c1"), cache.forceRefresh("c1")]);
    expect(r1.accessToken).toBe(r2.accessToken);
    expect(invocations).toBe(1);
  });
});

describe("OAuthTokenCache — cache TTL semantics", () => {
  it("expires the cache entry after CACHE_TTL_MS even when token is far from expiry", async () => {
    let invocations = 0;
    const originalNow = Date.now;
    let nowOffset = 0;
    Date.now = () => originalNow() + nowOffset;

    try {
      const { cache } = makeHarness(() => {
        invocations++;
        return makeJsonResponse(
          makeTokenResponse({
            accessToken: `tok-${invocations}`,
            expiresAt: originalNow() + 60 * 60_000,
          }),
        );
      });

      await cache.getToken("c1");
      // Advance past CACHE_TTL_MS
      nowOffset = CACHE_TTL_MS + 1_000;
      await cache.getToken("c1");
      expect(invocations).toBe(2);
    } finally {
      Date.now = originalNow;
    }
  });
});

describe("OAuthTokenCache — hardening (Phase 8)", () => {
  it("propagates network error and clears in-flight so the next call retries", async () => {
    let invocations = 0;
    const calls: string[] = [];
    const fetchFn = mock(async (url: unknown) => {
      const u = typeof url === "string" ? url : (url as URL).toString();
      calls.push(u);
      invocations++;
      if (invocations === 1) throw new Error("ECONNREFUSED");
      return makeJsonResponse(makeTokenResponse());
    });
    const cache = new OAuthTokenCache({
      getPlatformApiUrl: () => "http://platform",
      getRunToken: () => "run-tok",
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    await expect(cache.getToken("c1")).rejects.toThrow(/ECONNREFUSED/);
    // First failure must NOT poison subsequent reads — singleflight cleanup
    // runs in `.finally()` so the second call re-issues the fetch.
    const t = await cache.getToken("c1");
    expect(t.accessToken).toBe("tok-fresh");
    expect(invocations).toBe(2);
  });

  it("treats malformed JSON from the platform as a generic error (no crash)", async () => {
    const { cache } = makeHarness(
      () => new Response("<html>500 Internal Server Error</html>", { status: 500 }),
    );
    await expect(cache.getToken("c1")).rejects.toThrow(/500/);
  });

  it("singleflights forceRefresh + getToken ⇒ exactly one platform call", async () => {
    let invocations = 0;
    const { cache } = makeHarness(async () => {
      invocations++;
      await new Promise((r) => setTimeout(r, 5));
      return makeJsonResponse(makeTokenResponse({ accessToken: "tok-shared" }));
    });

    // Spawn refresh + read concurrently — second arrival must join the inflight
    const [r1, r2, r3] = await Promise.all([
      cache.forceRefresh("c1"),
      cache.getToken("c1"),
      cache.forceRefresh("c1"),
    ]);
    expect(r1.accessToken).toBe("tok-shared");
    expect(r2.accessToken).toBe("tok-shared");
    expect(r3.accessToken).toBe("tok-shared");
    expect(invocations).toBe(1);
  });

  it("forceRefresh failure clears the inflight slot — next call re-issues", async () => {
    let invocations = 0;
    const { cache } = makeHarness((url) => {
      invocations++;
      if (url.endsWith("/refresh") && invocations === 1) {
        return new Response('{"detail":"upstream 503"}', {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      }
      return makeJsonResponse(makeTokenResponse({ accessToken: "tok-eventual" }));
    });

    await expect(cache.forceRefresh("c1")).rejects.toThrow(/503/);
    const t = await cache.forceRefresh("c1");
    expect(t.accessToken).toBe("tok-eventual");
    expect(invocations).toBe(2);
  });

  it("does not cache an entry when fetch errors (next read does NOT see a stale value)", async () => {
    let invocations = 0;
    const fetchFn = mock(async () => {
      invocations++;
      if (invocations === 1) throw new Error("network unstable");
      return makeJsonResponse(makeTokenResponse({ accessToken: "tok-second" }));
    });
    const cache = new OAuthTokenCache({
      getPlatformApiUrl: () => "http://platform",
      getRunToken: () => "run-tok",
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    await expect(cache.getToken("c1")).rejects.toThrow(/network unstable/);
    // No cache pollution: must round-trip again
    const t = await cache.getToken("c1");
    expect(t.accessToken).toBe("tok-second");
    expect(invocations).toBe(2);
  });

  it("invalidate() is a no-op for unknown credentialId (does not throw)", async () => {
    const { cache } = makeHarness();
    expect(() => cache.invalidate("never-seen")).not.toThrow();
  });

  it("picks up rotated platformApiUrl/runToken via getters between calls", async () => {
    let platformUrl = "http://platform-1";
    let runToken = "run-tok-1";
    const calls: Array<{ url: string; auth: string }> = [];
    const fetchFn = mock(async (url: unknown, init?: RequestInit) => {
      const u = typeof url === "string" ? url : (url as URL).toString();
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url: u, auth: headers["Authorization"] ?? "" });
      return makeJsonResponse(makeTokenResponse());
    });
    const cache = new OAuthTokenCache({
      getPlatformApiUrl: () => platformUrl,
      getRunToken: () => runToken,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    await cache.getToken("c1");
    cache.invalidate("c1");
    platformUrl = "http://platform-2";
    runToken = "run-tok-2";
    await cache.getToken("c1");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toContain("http://platform-1");
    expect(calls[0]?.auth).toBe("Bearer run-tok-1");
    expect(calls[1]?.url).toContain("http://platform-2");
    expect(calls[1]?.auth).toBe("Bearer run-tok-2");
  });

  it("preserves NeedsReconnectionError type across the inflight wrapper", async () => {
    const { cache } = makeHarness(() => makeJsonResponse({ detail: "revoked" }, 410));
    let caught: unknown = null;
    try {
      await cache.getToken("c1");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(NeedsReconnectionError);
    expect((caught as NeedsReconnectionError).credentialId).toBe("c1");
  });
});
