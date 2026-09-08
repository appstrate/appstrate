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
 * PKCE state) out from under whatever else the run is doing. `keys()` is
 * prefixed by ioredis on the way out but not un-prefixed on the way back, so
 * the names it returns have to be stripped before `del` re-prefixes them.
 */
export async function flushEeRedis(): Promise<void> {
  const redis = getEeRedis();
  if (!redis) return;
  const prefix = redis.options.keyPrefix ?? "";
  const keys = await redis.keys("*");
  if (keys.length === 0) return;
  await redis.del(...keys.map((key) => key.slice(prefix.length)));
}
