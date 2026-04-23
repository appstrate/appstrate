// SPDX-License-Identifier: Apache-2.0

import type { RunEvent } from "@appstrate/afps-runtime/types";
import { getRedisConnection } from "../../lib/redis.ts";
import type { EventBuffer, BufferedEvent } from "./interface.ts";

const KEY_PREFIX = "appstrate:remote-run:buffer:";

/**
 * Redis-backed ordering buffer — a sorted set per run keyed by sequence.
 * Safe for multi-instance deployments: any API replica can flush events
 * enqueued by another as long as they share the same Redis cluster.
 */
export class RedisEventBuffer implements EventBuffer {
  private key(runId: string): string {
    return `${KEY_PREFIX}${runId}`;
  }

  async put(runId: string, sequence: number, event: RunEvent, ttlSeconds: number): Promise<void> {
    const redis = getRedisConnection();
    const key = this.key(runId);
    await redis.zadd(key, sequence, JSON.stringify(event));
    await redis.expire(key, ttlSeconds);
  }

  async peekLowest(runId: string): Promise<BufferedEvent | null> {
    const redis = getRedisConnection();
    const pair = await redis.zrange(this.key(runId), 0, 0, "WITHSCORES");
    if (pair.length === 0) return null;
    const event = JSON.parse(pair[0]!) as RunEvent;
    const sequence = Number(pair[1]!);
    return { sequence, event };
  }

  async remove(runId: string, sequence: number): Promise<void> {
    const redis = getRedisConnection();
    const key = this.key(runId);
    // ZREMRANGEBYSCORE is by-score; since we store one member per sequence
    // it is equivalent to removing the unique member — cheaper than reading
    // the member back to pass to ZREM.
    await redis.zremrangebyscore(key, sequence, sequence);
  }

  async clear(runId: string): Promise<void> {
    await getRedisConnection().del(this.key(runId));
  }

  async shutdown(): Promise<void> {
    // Redis connection lifecycle is managed globally by `closeRedis()`.
  }
}
