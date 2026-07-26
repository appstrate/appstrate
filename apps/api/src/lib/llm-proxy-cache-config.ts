// SPDX-License-Identifier: Apache-2.0

/**
 * Accessor for the `/api/llm-proxy/*` response-cache configuration.
 *
 * Reads `LLM_PROXY_CACHE_MODE` / `LLM_PROXY_CACHE_MAX_AGE` lazily from the
 * env (`getEnv()` caches after the first call). The env is the ONLY input:
 * there is deliberately no process-wide setter, so no code path can mutate
 * the proxy's cache behaviour at runtime. Tests that need a different mode
 * set the env vars and call `_resetCacheForTesting()` from `@appstrate/env`.
 */

import { getEnv } from "@appstrate/env";

export interface LlmProxyCacheConfig {
  /** When false, the proxy skips the cache layer entirely. */
  enabled: boolean;
  /** TTL applied to fresh writes. Ignored when `enabled` is false. */
  ttlSeconds: number;
}

export function getResponseCacheConfig(): LlmProxyCacheConfig {
  const env = getEnv();
  return {
    enabled: env.LLM_PROXY_CACHE_MODE !== "off",
    ttlSeconds: env.LLM_PROXY_CACHE_MAX_AGE,
  };
}
