/**
 * Redis helpers for cloud module tests.
 */
import { getCloudRedis } from "../../src/redis.ts";

export { getCloudRedis };

export async function flushCloudRedis(): Promise<void> {
  await getCloudRedis().flushall();
}
