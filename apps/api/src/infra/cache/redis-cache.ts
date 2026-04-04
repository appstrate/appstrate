// SPDX-License-Identifier: Apache-2.0

import { getRedisConnection } from "../../lib/redis.ts";
import type { KeyValueCache, CacheSetOptions } from "./interface.ts";

export class RedisCache implements KeyValueCache {
  async get(key: string): Promise<string | null> {
    return getRedisConnection().get(key);
  }

  async set(key: string, value: string, opts?: CacheSetOptions): Promise<boolean> {
    const redis = getRedisConnection();

    if (opts?.ttlSeconds && opts?.nx) {
      const result = await redis.set(key, value, "EX", opts.ttlSeconds, "NX");
      return result === "OK";
    }
    if (opts?.ttlSeconds) {
      const result = await redis.set(key, value, "EX", opts.ttlSeconds);
      return result === "OK";
    }
    if (opts?.nx) {
      const result = await redis.set(key, value, "NX");
      return result === "OK";
    }
    const result = await redis.set(key, value);
    return result === "OK";
  }

  async del(key: string): Promise<void> {
    await getRedisConnection().del(key);
  }

  async shutdown(): Promise<void> {
    // Redis connection lifecycle managed by lib/redis.ts
  }
}
