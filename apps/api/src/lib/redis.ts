// SPDX-License-Identifier: Apache-2.0

import Redis from "ioredis";
import { getEnv } from "@appstrate/env";
import { logger } from "./logger.ts";
import { getErrorMessage } from "@appstrate/core/errors";

let publisher: Redis | null = null;
let subscriber: Redis | null = null;
let queueConnection: Redis | null = null;

/**
 * Retries ioredis attempts per command before rejecting, on the connections
 * that serve HTTP requests.
 *
 * `null` means "retry forever", which is what BullMQ requires and what every
 * client here used to get. On a request path that is the wrong contract: while
 * Redis is unreachable, a rate-limit or cache command HANGS instead of
 * failing, so the request hangs with it and the caller sees a timeout rather
 * than an error. A finite count turns a Redis outage into a fast, handleable
 * rejection.
 */
const HTTP_MAX_RETRIES_PER_REQUEST = 3;

function createRedisClient(opts?: { forQueue?: boolean }): Redis {
  const url = getEnv().REDIS_URL;
  if (!url) throw new Error("REDIS_URL is required when using Redis-backed adapters");
  const client = new Redis(url, {
    // BullMQ mandates `null` on its own connections: its blocking reads
    // (BRPOPLPUSH) legitimately outlive any finite retry budget, and Worker
    // throws at construction otherwise. Everything else gets a finite budget.
    maxRetriesPerRequest: opts?.forQueue ? null : HTTP_MAX_RETRIES_PER_REQUEST,
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

/**
 * Shared client for request-path work: rate limiting, cache, event buffer,
 * distributed locks, pub/sub publishes. Fails commands fast when Redis is
 * down — see {@link HTTP_MAX_RETRIES_PER_REQUEST}.
 *
 * NOT for BullMQ: use {@link getRedisQueueConnection}.
 */
export function getRedisConnection(): Redis {
  if (!publisher) {
    publisher = createRedisClient();
  }
  return publisher;
}

/**
 * Dedicated client for BullMQ, which requires `maxRetriesPerRequest: null`.
 *
 * Separate from {@link getRedisConnection} so the queue's "retry forever"
 * contract cannot leak onto the request path. BullMQ additionally calls
 * `.duplicate()` internally for its blocking client, and duplicates inherit
 * these options — which is exactly why the finite budget must not be set
 * here.
 */
export function getRedisQueueConnection(): Redis {
  if (!queueConnection) {
    queueConnection = createRedisClient({ forQueue: true });
  }
  return queueConnection;
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
    await queueConnection?.quit();
  } catch (err) {
    logger.warn("Error closing Redis connections", {
      error: getErrorMessage(err),
    });
  }
  publisher = null;
  subscriber = null;
  queueConnection = null;
}
