// SPDX-License-Identifier: Apache-2.0

/**
 * Accessor for the `/api/llm-proxy/*` response-cache configuration.
 *
 * Reads `LLM_PROXY_CACHE_MODE` / `LLM_PROXY_CACHE_MAX_AGE` lazily from
 * the env (`getEnv()` caches after the first call). Tests inject
 * overrides via `setResponseCacheConfig` and restore via
 * `resetResponseCacheConfigForTesting`.
 */

import { getEnv } from "@appstrate/env";

export interface LlmProxyCacheConfig {
  /** When false, the proxy skips the cache layer entirely. */
  enabled: boolean;
  /** TTL applied to fresh writes. Ignored when `enabled` is false. */
  ttlSeconds: number;
}

let _override: LlmProxyCacheConfig | null = null;

export function setResponseCacheConfig(cfg: LlmProxyCacheConfig): void {
  _override = cfg;
}

export function getResponseCacheConfig(): LlmProxyCacheConfig {
  if (_override) return _override;
  const env = getEnv();
  return {
    enabled: env.LLM_PROXY_CACHE_MODE !== "off",
    ttlSeconds: env.LLM_PROXY_CACHE_MAX_AGE,
  };
}

/** @internal — test helper. Restores the env-driven default. */
export function resetResponseCacheConfigForTesting(): void {
  _override = null;
}
