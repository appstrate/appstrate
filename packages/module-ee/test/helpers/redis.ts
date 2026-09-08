// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

/**
 * Redis helpers for EE module tests.
 */
import { getEeRedis } from "../../src/redis.ts";

/**
 * Drop this module's Redis keys — the `ee:` prefix only.
 *
 * NOT `flushall()`: the harness hands every module the platform's test Redis,
 * so wiping the server would take the platform's own keys (rate limits, queues,
 * PKCE state) out from under whatever else the run is doing. `KEYS` takes a
 * pattern, not a key, so ioredis does NOT prefix it (`@ioredis/commands` gives
 * `keys` `keyStart: 0`) — the pattern is written out in full, and the names it
 * returns come back prefixed, to be stripped before `del` re-prefixes them.
 */
export async function flushEeRedis(): Promise<void> {
  const redis = getEeRedis();
  if (!redis) return;
  const prefix = redis.options.keyPrefix ?? "";
  const keys = await redis.keys(`${prefix}*`);
  if (keys.length === 0) return;
  await redis.del(...keys.map((key) => key.slice(prefix.length)));
}
