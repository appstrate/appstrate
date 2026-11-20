// SPDX-License-Identifier: Apache-2.0

import Redis from "ioredis";

let billingRedis: Redis | null = null;

export function getBillingRedis(): Redis | null {
  return billingRedis;
}

export function initBillingRedis(redisUrl: string): void {
  if (!redisUrl) return; // Redis is optional — billing features degrade gracefully
  billingRedis = new Redis(redisUrl, {
    keyPrefix: "ee:",
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
  });
}
