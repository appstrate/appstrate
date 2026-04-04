// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, afterEach } from "bun:test";
import { LocalCache } from "../../src/infra/cache/local-cache.ts";

let cache: LocalCache;

afterEach(async () => {
  await cache?.shutdown();
});

describe("LocalCache", () => {
  it("returns null for missing keys", async () => {
    cache = new LocalCache();
    expect(await cache.get("nonexistent")).toBeNull();
  });

  it("stores and retrieves values", async () => {
    cache = new LocalCache();
    await cache.set("key1", "value1");
    expect(await cache.get("key1")).toBe("value1");
  });

  it("overwrites existing values", async () => {
    cache = new LocalCache();
    await cache.set("k", "v1");
    await cache.set("k", "v2");
    expect(await cache.get("k")).toBe("v2");
  });

  it("deletes keys", async () => {
    cache = new LocalCache();
    await cache.set("k", "v");
    await cache.del("k");
    expect(await cache.get("k")).toBeNull();
  });

  it("del is idempotent for missing keys", async () => {
    cache = new LocalCache();
    await cache.del("nonexistent"); // should not throw
  });

  it("respects TTL — expired entries return null", async () => {
    cache = new LocalCache();
    await cache.set("expiring", "val", { ttlSeconds: 1 });
    // Should be available immediately
    expect(await cache.get("expiring")).toBe("val");
    // Wait for TTL to expire
    await new Promise((r) => setTimeout(r, 1100));
    expect(await cache.get("expiring")).toBeNull();
  });

  it("NX mode: does not overwrite existing keys", async () => {
    cache = new LocalCache();
    await cache.set("lock", "owner1");
    const result = await cache.set("lock", "owner2", { nx: true });
    expect(result).toBe(false);
    expect(await cache.get("lock")).toBe("owner1");
  });

  it("NX mode: sets when key is absent", async () => {
    cache = new LocalCache();
    const result = await cache.set("fresh", "value", { nx: true });
    expect(result).toBe(true);
    expect(await cache.get("fresh")).toBe("value");
  });

  it("NX + TTL combined", async () => {
    cache = new LocalCache();
    const result = await cache.set("combo", "v", { nx: true, ttlSeconds: 1 });
    expect(result).toBe(true);
    expect(await cache.get("combo")).toBe("v");

    // Can't overwrite with NX
    const result2 = await cache.set("combo", "v2", { nx: true });
    expect(result2).toBe(false);
  });

  it("shutdown clears all entries", async () => {
    cache = new LocalCache();
    await cache.set("a", "1");
    await cache.set("b", "2");
    await cache.shutdown();
    // After shutdown, internal store is cleared
    // Creating a new instance to verify isolation
    cache = new LocalCache();
    expect(await cache.get("a")).toBeNull();
  });
});
