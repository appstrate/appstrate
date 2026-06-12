// SPDX-License-Identifier: Apache-2.0

/**
 * BYOI credential cache for the sidecar's legacy `api_call` path.
 *
 * Mirrors {@link OAuthTokenCache} (`./oauth-token-cache.ts`): without a
 * cache, every `api_call` round-trips
 * `GET /internal/credentials/:integrationId` to the platform even
 * though the credential bag is stable for the lifetime of a run. Two
 * layers of deduplication:
 *
 *   - **Cache**: an in-memory `Map<integrationId, entry>` valid for
 *     {@link CREDENTIALS_CACHE_TTL_MS}. The short TTL keeps the sidecar
 *     responsive to platform-side rotation without polling.
 *   - **Singleflight**: concurrent fetches for the same integration
 *     coalesce onto one in-flight promise.
 *
 * The 401-retry path in `credential-proxy.ts` calls the platform's
 * `/refresh` endpoint via `refreshCredentials` (wired in `server.ts`),
 * which MUST bypass this cache and then call {@link set} (rotation
 * succeeded — subsequent calls within the TTL need the fresh token, not
 * the stale one) or {@link invalidate} (terminal failure — stop serving
 * the dead credential from cache).
 */

import type { CredentialsResponse } from "./helpers.ts";

export const CREDENTIALS_CACHE_TTL_MS = 30_000;

interface CachedCredentials {
  value: CredentialsResponse;
  fetchedAt: number;
}

/**
 * Stateful, per-sidecar credential cache. One instance per sidecar
 * process — a single sidecar serves a single run, so cross-run cache
 * pollution is not a concern.
 */
export class CredentialsCache {
  private readonly cache = new Map<string, CachedCredentials>();
  private readonly inflight = new Map<string, Promise<CredentialsResponse>>();

  constructor(
    private readonly fetchFresh: (integrationId: string) => Promise<CredentialsResponse>,
    private readonly ttlMs: number = CREDENTIALS_CACHE_TTL_MS,
  ) {}

  /**
   * Resolve credentials for the given integration. Served from cache
   * within the TTL; concurrent misses share a single in-flight fetch.
   */
  async get(integrationId: string): Promise<CredentialsResponse> {
    const cached = this.cache.get(integrationId);
    if (cached && Date.now() - cached.fetchedAt < this.ttlMs) {
      return cached.value;
    }

    const inflight = this.inflight.get(integrationId);
    if (inflight) return inflight;

    const promise = this.fetchFresh(integrationId)
      .then((value) => {
        this.cache.set(integrationId, { value, fetchedAt: Date.now() });
        return value;
      })
      .finally(() => {
        this.inflight.delete(integrationId);
      });
    this.inflight.set(integrationId, promise);
    return promise;
  }

  /**
   * Replace the cached entry with refreshed credentials. Called by the
   * 401-retry path after a successful platform `/refresh` so the next
   * `get()` within the TTL serves the rotated token.
   */
  set(integrationId: string, value: CredentialsResponse): void {
    this.cache.set(integrationId, { value, fetchedAt: Date.now() });
  }

  /**
   * Drop the cached entry. Called when the platform `/refresh` fails
   * terminally — the next `get()` round-trips to the platform.
   */
  invalidate(integrationId: string): void {
    this.cache.delete(integrationId);
  }
}
