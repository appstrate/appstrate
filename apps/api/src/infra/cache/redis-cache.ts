// SPDX-License-Identifier: Apache-2.0

import { getRedisConnection } from "../../lib/redis.ts";
import type { KeyValueCache, CacheSetOptions } from "./interface.ts";

export class RedisCache implements KeyValueCache {
  async get(key: string): Promise<string | null> {
    return getRedisConnection().get(key);
  }

  async set(key: string, value: string, opts?: CacheSetOptions): Promise<boolean> {
    const redis = getRedisConnection();
    const args: (string | number)[] = [key, value];

    if (opts?.ttlSeconds) {
      args.push("EX", opts.ttlSeconds);
    }
    if (opts?.nx) {
      args.push("NX");
    }

    const result = await (
      redis as never as { call: (...a: unknown[]) => Promise<string | null> }
    ).call("SET", ...args);
    return result === "OK";
  }

  async del(key: string): Promise<void> {
    await getRedisConnection().del(key);
  }

  async shutdown(): Promise<void> {
    // Redis connection lifecycle managed by lib/redis.ts
  }
}
