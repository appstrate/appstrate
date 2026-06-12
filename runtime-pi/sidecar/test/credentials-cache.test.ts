// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the BYOI credential fetch cache (TTL + singleflight),
 * mirroring the OAuth token cache it is modelled on.
 */

import { describe, it, expect } from "bun:test";
import { CredentialsCache, CREDENTIALS_CACHE_TTL_MS } from "../credentials-cache.ts";
import type { CredentialsResponse } from "../helpers.ts";

function makeCreds(token: string): CredentialsResponse {
  return {
    credentials: { token },
    authorizedUris: null,
    allowAllUris: false,
    credentialFieldName: "token",
  };
}

describe("CredentialsCache", () => {
  it("serves the second read from cache without a second fetch", async () => {
    let calls = 0;
    const cache = new CredentialsCache(async () => {
      calls += 1;
      return makeCreds("t1");
    });
    const a = await cache.get("int-1");
    const b = await cache.get("int-1");
    expect(a).toBe(b);
    expect(calls).toBe(1);
  });

  it("coalesces concurrent misses onto one in-flight fetch (singleflight)", async () => {
    let calls = 0;
    let release!: (v: CredentialsResponse) => void;
    const gate = new Promise<CredentialsResponse>((resolve) => {
      release = resolve;
    });
    const cache = new CredentialsCache(async () => {
      calls += 1;
      return gate;
    });
    const p1 = cache.get("int-1");
    const p2 = cache.get("int-1");
    release(makeCreds("t1"));
    const [a, b] = await Promise.all([p1, p2]);
    expect(a).toBe(b);
    expect(calls).toBe(1);
  });

  it("caches per integration id — no cross-integration sharing", async () => {
    const cache = new CredentialsCache(async (id) => makeCreds(`token-${id}`));
    const a = await cache.get("int-a");
    const b = await cache.get("int-b");
    expect(a.credentials["token"]).toBe("token-int-a");
    expect(b.credentials["token"]).toBe("token-int-b");
  });

  it("refetches after the TTL elapses", async () => {
    let calls = 0;
    const cache = new CredentialsCache(async () => {
      calls += 1;
      return makeCreds(`t${calls}`);
    }, 5); // 5 ms TTL for the test
    await cache.get("int-1");
    await new Promise((r) => setTimeout(r, 10));
    const second = await cache.get("int-1");
    expect(calls).toBe(2);
    expect(second.credentials["token"]).toBe("t2");
  });

  it("invalidate() forces the next read to round-trip", async () => {
    let calls = 0;
    const cache = new CredentialsCache(async () => {
      calls += 1;
      return makeCreds(`t${calls}`);
    });
    await cache.get("int-1");
    cache.invalidate("int-1");
    const second = await cache.get("int-1");
    expect(calls).toBe(2);
    expect(second.credentials["token"]).toBe("t2");
  });

  it("set() replaces the cached entry (401-retry refresh path)", async () => {
    let calls = 0;
    const cache = new CredentialsCache(async () => {
      calls += 1;
      return makeCreds("stale");
    });
    await cache.get("int-1");
    cache.set("int-1", makeCreds("rotated"));
    const next = await cache.get("int-1");
    expect(calls).toBe(1); // no extra fetch — the refreshed bag is served
    expect(next.credentials["token"]).toBe("rotated");
  });

  it("a failed fetch is not cached — the next read retries", async () => {
    let calls = 0;
    const cache = new CredentialsCache(async () => {
      calls += 1;
      if (calls === 1) throw new Error("platform unavailable");
      return makeCreds("ok");
    });
    await expect(cache.get("int-1")).rejects.toThrow("platform unavailable");
    const second = await cache.get("int-1");
    expect(calls).toBe(2);
    expect(second.credentials["token"]).toBe("ok");
  });

  it("exports a 30s default TTL", () => {
    expect(CREDENTIALS_CACHE_TTL_MS).toBe(30_000);
  });
});
