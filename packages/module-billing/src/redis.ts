// SPDX-License-Identifier: Apache-2.0

import Redis from "ioredis";

let eeRedis: Redis | null = null;

export function getEeRedis(): Redis | null {
  return eeRedis;
}

export function initEeRedis(redisUrl: string): void {
  if (!redisUrl) return; // Redis is optional — EE features degrade gracefully
  eeRedis = new Redis(redisUrl, {
    keyPrefix: "ee:",
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
  });
}
