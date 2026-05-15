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
    await redis.expire(key, ttlSeconds);
  }

  async peekLowest(runId: string): Promise<BufferedEvent | null> {
    const redis = getRedisConnection();
    const pair = await redis.zrange(this.key(runId), 0, 0, "WITHSCORES");
    if (pair.length === 0) return null;
    const event = parseMember(pair[0]!);
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

function parseMember(raw: string): RunEvent {
  // Members written by `put` are `${sequence}|${json}`. Older entries
  // written before this fix carried the bare JSON, so fall back when the
  // separator is missing — a buffer that survives the upgrade still
  // drains correctly.
  const sep = raw.indexOf("|");
  if (sep < 0) return JSON.parse(raw) as RunEvent;
  // Validate the prefix is digits to avoid mis-splitting a JSON payload
  // whose first character is `|`. `|` cannot appear inside a JSON
  // top-level object before the opening `{`, but be defensive.
  const prefix = raw.substring(0, sep);
  if (!/^\d+$/.test(prefix)) return JSON.parse(raw) as RunEvent;
  return JSON.parse(raw.substring(sep + 1)) as RunEvent;
}
