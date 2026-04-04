// SPDX-License-Identifier: Apache-2.0

import { RateLimiterRedis } from "rate-limiter-flexible";
import type { RateLimiterAbstract } from "rate-limiter-flexible";
import { getRedisConnection } from "../../lib/redis.ts";
import type { RateLimiterFactory } from "./interface.ts";

export class RedisRateLimiterFactory implements RateLimiterFactory {
  create(points: number, duration: number, keyPrefix: string): RateLimiterAbstract {
    return new RateLimiterRedis({
      storeClient: getRedisConnection(),
      points,
      duration,
      keyPrefix,
    });
  }
}
