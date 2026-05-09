// SPDX-License-Identifier: Apache-2.0

import Redis from "ioredis";
import { getEnv } from "@appstrate/env";
import { logger } from "./logger.ts";
import { getErrorMessage } from "@appstrate/core/errors";

let publisher: Redis | null = null;
let subscriber: Redis | null = null;

function createRedisClient(): Redis {
  const url = getEnv().REDIS_URL;
  if (!url) throw new Error("REDIS_URL is required when using Redis-backed adapters");
  const client = new Redis(url, {
    maxRetriesPerRequest: null, // required by BullMQ
    enableReadyCheck: false,
    connectTimeout: 10_000,
    retryStrategy(times) {
      return Math.min(times * 200, 5_000);
    },
  });

  client.on("error", (err) => {
    logger.error("Redis connection error", { error: err.message });
  });
  client.on("reconnecting", () => {
    logger.info("Reconnecting to Redis...");
  });

  return client;
}

export function getRedisConnection(): Redis {
  if (!publisher) {
    publisher = createRedisClient();
  }
  return publisher;
}

export function getRedisSubscriber(): Redis {
  if (!subscriber) {
    // Subscriber needs its own connection (cannot share with publisher in Pub/Sub mode)
    subscriber = createRedisClient();
  }
  return subscriber;
}

export async function closeRedis(): Promise<void> {
  try {
    await publisher?.quit();
    await subscriber?.quit();
  } catch (err) {
    logger.warn("Error closing Redis connections", {
      error: getErrorMessage(err),
    });
  }
  publisher = null;
  subscriber = null;
}
