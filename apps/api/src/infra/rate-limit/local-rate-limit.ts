// SPDX-License-Identifier: Apache-2.0

import { RateLimiterMemory } from "rate-limiter-flexible";
import type { RateLimiterAbstract } from "rate-limiter-flexible";
import type { RateLimiterFactory } from "./interface.ts";

export class LocalRateLimiterFactory implements RateLimiterFactory {
  create(points: number, duration: number, keyPrefix: string): RateLimiterAbstract {
    return new RateLimiterMemory({
      points,
      duration,
      keyPrefix,
    });
  }
}
