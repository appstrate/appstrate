// SPDX-License-Identifier: Apache-2.0

/**
 * OAuth token cache for the sidecar's `/llm/*` proxy.
 *
 * Backs the OAuth code path (cf. SPEC §5.2): the sidecar polls
 * `GET /internal/oauth-token/:connectionId` on the platform API to
 * obtain a fresh access token + provider runtime config (apiShape,
 * baseUrl, identity hints), then caches the result for 30s.
 *
 * Two layers of deduplication:
 *
 *   - **Cache**: an in-memory `Map<connectionId, CachedToken>` that
 *     answers most reads in O(1). Entries are valid for {@link CACHE_TTL_MS}
 *     **and** until the underlying access token reaches the
 *     {@link REFRESH_THRESHOLD_MS} expiry lead time.
 *   - **Singleflight**: a parallel `Map<connectionId, Promise>` that
 *     coalesces concurrent in-flight fetches. 50 simultaneous LLM
 *     requests with a stale token yield exactly 1 platform fetch.
 *
 * Refresh strategy: when the cached token's `expiresAt` is within
 * {@link REFRESH_THRESHOLD_MS} of now, the cache calls
 * `POST /internal/oauth-token/:id/refresh` instead of the read endpoint
 * — proactive refresh ahead of expiry to avoid 401-bounce on the agent
 * request path.
 */

export interface CachedToken {
  accessToken: string;
  /** Epoch milliseconds. `null` when expiry is unknown — treated as "always refresh". */
  expiresAt: number | null;
  fetchedAt: number;
  apiShape: "anthropic-messages" | "openai-responses";
  baseUrl: string;
  rewriteUrlPath?: { from: string; to: string };
  forceStream?: boolean;
  forceStore?: boolean;
  /** Codex only — surfaced as `chatgpt-account-id` header on upstream. */
  accountId?: string;
  providerId: string;
}

/** Wire shape returned by the platform's `/internal/oauth-token/:id` endpoint. */
export interface PlatformTokenResponse {
  accessToken: string;
  expiresAt: number | null;
  apiShape: "anthropic-messages" | "openai-responses";
  baseUrl: string;
  rewriteUrlPath?: { from: string; to: string };
  forceStream?: boolean;
  forceStore?: boolean;
  accountId?: string;
  providerId: string;
}

/** Signaled when the platform returns 410 (`needsReconnection=true`). */
export class NeedsReconnectionError extends Error {
  constructor(public readonly connectionId: string) {
    super(`OAuth connection ${connectionId} needs reconnection`);
    this.name = "NeedsReconnectionError";
  }
}

export const CACHE_TTL_MS = 30_000;
export const REFRESH_THRESHOLD_MS = 5 * 60_000;

export interface OAuthTokenCacheDeps {
  /**
   * Returns the current platform API base URL. Wrapped in a getter so
   * the cache picks up post-`/configure` mutations (the sidecar's runtime
   * config can change after pool acquisition).
   */
  getPlatformApiUrl: () => string;
  /** Returns the current run token (Bearer authenticator for `/internal/*`). */
  getRunToken: () => string;
  /** Injectable for tests — defaults to global fetch. */
  fetchFn?: typeof fetch;
}

/**
 * Stateful, per-sidecar token cache. One instance per sidecar process —
 * a single sidecar serves a single run, so cross-run cache pollution is
 * not a concern.
 */
export class OAuthTokenCache {
  private readonly cache = new Map<string, CachedToken>();
  private readonly inflight = new Map<string, Promise<CachedToken>>();
  private readonly fetchFn: typeof fetch;

  constructor(private readonly deps: OAuthTokenCacheDeps) {
    this.fetchFn = deps.fetchFn ?? fetch;
  }

  /**
   * Resolve a fresh access token + provider runtime config for the given
   * connection. Concurrent calls for the same `connectionId` share a
   * single in-flight promise.
   */
  async getToken(connectionId: string): Promise<CachedToken> {
    const cached = this.cache.get(connectionId);
    if (cached && this.isFresh(cached)) {
      return cached;
    }

    const inflight = this.inflight.get(connectionId);
    if (inflight) return inflight;

    const promise = this.fetchAndStore(connectionId).finally(() => {
      this.inflight.delete(connectionId);
    });
    this.inflight.set(connectionId, promise);
    return promise;
  }

  /**
   * Drop the cached token for the given connection. Called from the
   * `/llm/*` 401-retry path to force the next `getToken()` to round-trip
   * to the platform.
   */
  invalidate(connectionId: string): void {
    this.cache.delete(connectionId);
  }

  /**
   * Force a token refresh (calls the platform's refresh endpoint) and
   * replace the cached entry. Used by the 401-retry path.
   */
  async forceRefresh(connectionId: string): Promise<CachedToken> {
    // Coalesce with any in-flight read so that a refresh during a fetch
    // doesn't double-call the platform.
    const existing = this.inflight.get(connectionId);
    if (existing) return existing;

    const promise = this.callRefresh(connectionId)
      .then((fresh) => {
        const entry = this.toCached(fresh);
        this.cache.set(connectionId, entry);
        return entry;
      })
      .finally(() => {
        this.inflight.delete(connectionId);
      });
    this.inflight.set(connectionId, promise);
    return promise;
  }

  private isFresh(entry: CachedToken): boolean {
    const now = Date.now();
    if (now - entry.fetchedAt >= CACHE_TTL_MS) return false;
    if (entry.expiresAt === null) return false;
    if (entry.expiresAt - now <= REFRESH_THRESHOLD_MS) return false;
    return true;
  }

  private async fetchAndStore(connectionId: string): Promise<CachedToken> {
    const fresh = await this.callRead(connectionId);
    if (this.needsProactiveRefresh(fresh.expiresAt)) {
      const refreshed = await this.callRefresh(connectionId);
      const entry = this.toCached(refreshed);
      this.cache.set(connectionId, entry);
      return entry;
    }
    const entry = this.toCached(fresh);
    this.cache.set(connectionId, entry);
    return entry;
  }

  private needsProactiveRefresh(expiresAt: number | null): boolean {
    if (expiresAt === null) return true;
    return expiresAt - Date.now() <= REFRESH_THRESHOLD_MS;
  }

  private toCached(payload: PlatformTokenResponse): CachedToken {
    return {
      ...payload,
      fetchedAt: Date.now(),
    };
  }

  private async callRead(connectionId: string): Promise<PlatformTokenResponse> {
    const url = `${this.deps.getPlatformApiUrl()}/internal/oauth-token/${encodeURIComponent(connectionId)}`;
    const res = await this.fetchFn(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${this.deps.getRunToken()}` },
    });
    return this.parsePlatformResponse(res, connectionId);
  }

  private async callRefresh(connectionId: string): Promise<PlatformTokenResponse> {
    const url = `${this.deps.getPlatformApiUrl()}/internal/oauth-token/${encodeURIComponent(connectionId)}/refresh`;
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.deps.getRunToken()}` },
    });
    return this.parsePlatformResponse(res, connectionId);
  }

  private async parsePlatformResponse(
    res: Response,
    connectionId: string,
  ): Promise<PlatformTokenResponse> {
    if (res.status === 410) {
      throw new NeedsReconnectionError(connectionId);
    }
    if (!res.ok) {
      let detail = "";
      try {
        const body = (await res.json()) as { detail?: string };
        if (body.detail) detail = body.detail;
      } catch {
        // ignore parse failures
      }
      throw new Error(detail || `OAuth token endpoint returned ${res.status} for ${connectionId}`);
    }
    return (await res.json()) as PlatformTokenResponse;
  }
}
