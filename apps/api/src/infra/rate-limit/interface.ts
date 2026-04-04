// SPDX-License-Identifier: Apache-2.0

/**
 * Abstract rate limiter factory.
 * Creates rate limiter instances backed by Redis or in-memory storage.
 */

import type { RateLimiterAbstract } from "rate-limiter-flexible";

export type { RateLimiterAbstract };

export interface RateLimiterFactory {
  create(points: number, duration: number, keyPrefix: string): RateLimiterAbstract;
}
