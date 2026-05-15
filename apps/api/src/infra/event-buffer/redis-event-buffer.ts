// SPDX-License-Identifier: Apache-2.0

import type { RunEvent } from "@appstrate/afps-runtime/types";
import { getRedisConnection } from "../../lib/redis.ts";
import { logger } from "../../lib/logger.ts";
import type { EventBuffer, BufferedEvent } from "./interface.ts";

const KEY_PREFIX = "appstrate:remote-run:buffer:";

/**
 * Hard cap on buffered events per run. A pathological runner that
 * permanently skips a sequence would otherwise accumulate every later
 * event in Redis until the watchdog finalises the run — sized 100×
 * above any realistic burst so the happy path never trips this. When
 * it does trip, we drop the LOWEST-scored entries (the stale ones
 * waiting on the missing gap) so the most recent events are kept.
 */
const MAX_BUFFER_ENTRIES = 10_000;

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
    // The member must be unique per sequence — sorted-set semantics. ZADD
    // with an existing member updates the score rather than inserting a
    // new entry, so two events whose `JSON.stringify(event)` happens to
    // collapse to the same string (10 parallel `provider.called` events
    // with the same `toolCallId`/`durationMs`/`status` after JSON
    // omits `undefined` fields) would silently overwrite each other and
    // strand the earlier sequences. The runner's monotonic sequence is
    // already unique by construction, so prefix the JSON with it (and a
    // separator that JSON can't produce at column 0) to make the member
    // identity sequence-keyed regardless of payload content.
    await redis.zadd(key, sequence, `${sequence}|${JSON.stringify(event)}`);
    // Trim from the lowest-scored end if we overflow MAX_BUFFER_ENTRIES.
    // `0` is the lowest rank; `-(MAX_BUFFER_ENTRIES + 1)` keeps the
    // top-N most recent. Returns the number of removed members — non-zero
    // means we dropped events, which is a real anomaly worth surfacing.
    const trimmed = await redis.zremrangebyrank(key, 0, -(MAX_BUFFER_ENTRIES + 1));
    if (trimmed > 0) {
      logger.warn("event buffer overflowed — dropped oldest entries", {
        runId,
        trimmed,
        cap: MAX_BUFFER_ENTRIES,
      });
    }
    await redis.expire(key, ttlSeconds);
  }

  async peekLowest(runId: string): Promise<BufferedEvent | null> {
    const redis = getRedisConnection();
    const pair = await redis.zrange(this.key(runId), 0, 0, "WITHSCORES");
    if (pair.length === 0) return null;
    const raw = pair[0]!;
    // Members are written by `put` as `${sequence}|${json}`. Strip the prefix.
    const event = JSON.parse(raw.substring(raw.indexOf("|") + 1)) as RunEvent;
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
