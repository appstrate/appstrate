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
    // collapse to the same string (10 parallel `api_call.called` events
    // with the same `toolCallId`/`durationMs`/`status` after JSON
    // omits `undefined` fields) would silently overwrite each other and
    // strand the earlier sequences. The runner's monotonic sequence is
    // already unique by construction, so prefix the JSON with it (and a
    // separator that JSON can't produce at column 0) to make the member
    // identity sequence-keyed regardless of payload content.
    //
    // The three commands are ONE round trip via MULTI. They were three
    // sequential awaits, so every ingested event of every remote run paid
    // three network RTTs where one suffices — and the window between the
    // ZADD and the EXPIRE meant a crash in between left a key with no TTL.
    // MULTI also makes the trim atomic with the insert, so a concurrent
    // reader can never observe the set above its cap.
    //
    // ZREMRANGEBYRANK trims from the lowest-scored end on overflow: `0` is
    // the lowest rank, `-(MAX_BUFFER_ENTRIES + 1)` keeps the top-N most
    // recent. Its reply is the number of removed members — non-zero means we
    // dropped events, which is a real anomaly worth surfacing.
    const replies = await redis
      .multi()
      .zadd(key, sequence, `${sequence}|${JSON.stringify(event)}`)
      .zremrangebyrank(key, 0, -(MAX_BUFFER_ENTRIES + 1))
      .expire(key, ttlSeconds)
      .exec();

    // `exec()` resolves to null when the transaction was discarded (e.g. the
    // connection dropped mid-MULTI) and otherwise to one `[error, reply]`
    // tuple per queued command. Surface either as a throw so the caller's
    // existing failure handling is unchanged from the sequential-await
    // version, where any command rejecting propagated.
    if (replies === null) {
      throw new Error("event buffer MULTI discarded");
    }
    for (const [err] of replies) {
      if (err) throw err;
    }

    const trimmed = Number(replies[1]?.[1] ?? 0);
    if (trimmed > 0) {
      logger.warn("event buffer overflowed — dropped oldest entries", {
        runId,
        trimmed,
        cap: MAX_BUFFER_ENTRIES,
      });
    }
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
