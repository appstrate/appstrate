// SPDX-License-Identifier: Apache-2.0

/**
 * Read-once accessor for the LLM proxy response-cache configuration.
 *
 * Why this is a dedicated module and not inlined in `core.ts`:
 *   The Portkey module's `init()` resolves `PORTKEY_CACHE_MODE` once at
 *   boot and stashes the effective mode here. Reading from a module
 *   variable keeps the per-request path free of env-getter calls and
 *   lets tests inject overrides without touching `process.env`.
 */

export interface LlmProxyCacheConfig {
  /** When false, the proxy skips the cache layer entirely. */
  enabled: boolean;
  /** TTL applied to fresh writes. Ignored when `enabled` is false. */
  ttlSeconds: number;
}

const DEFAULT_CONFIG: LlmProxyCacheConfig = { enabled: false, ttlSeconds: 0 };
let _config: LlmProxyCacheConfig = DEFAULT_CONFIG;

export function setResponseCacheConfig(cfg: LlmProxyCacheConfig): void {
  _config = cfg;
}

export function getResponseCacheConfig(): LlmProxyCacheConfig {
  return _config;
}

/** @internal — test helper. Restores the boot-time default. */
export function resetResponseCacheConfigForTesting(): void {
  _config = DEFAULT_CONFIG;
}
