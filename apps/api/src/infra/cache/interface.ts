// SPDX-License-Identifier: Apache-2.0

/**
 * Abstract key-value cache interface.
 * Implementations: Redis and local in-memory (Map + TTL).
 */

export interface KeyValueCache {
  /** Get a value by key. Returns null if not found or expired. */
  get(key: string): Promise<string | null>;

  /**
   * Set a value with optional TTL and NX semantics.
   * @returns true if the value was set, false if NX was specified and the key already exists.
   */
  set(key: string, value: string, opts?: CacheSetOptions): Promise<boolean>;

  /** Delete a key. Idempotent. */
  del(key: string): Promise<void>;

  /** Graceful shutdown — cleanup resources. */
  shutdown(): Promise<void>;
}

export interface CacheSetOptions {
  /** Time-to-live in seconds. */
  ttlSeconds?: number;
  /** Only set if key does not exist (SET NX). */
  nx?: boolean;
}
