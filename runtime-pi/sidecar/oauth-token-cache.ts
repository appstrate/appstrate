// SPDX-License-Identifier: Apache-2.0

/**
 * OAuth token cache for the sidecar's `/llm/*` proxy.
 *
 * Backs the OAuth code path (cf. SPEC §5.2): the sidecar polls
 * `GET /internal/oauth-token/:credentialId` on the platform API to
 * obtain a fresh access token (+ optional `accountId`), then caches the
 * result for {@link CACHE_TTL_MS}. The platform's read endpoint already
 * proactively refreshes whenever the token is within
 * `OAUTH_REFRESH_LEAD_MS` of expiry, so the sidecar trusts whatever it
 * returns and only round-trips again on 401 via {@link forceRefresh}.
 *
 * Two layers of deduplication:
 *
 *   - **Cache**: an in-memory `Map<credentialId, CachedToken>` that
 *     answers most reads in O(1). Entries are valid for {@link CACHE_TTL_MS}.
 *   - **Singleflight**: a parallel `Map<credentialId, Promise>` that
 *     coalesces concurrent in-flight fetches. 50 simultaneous LLM
 *     requests with a stale token yield exactly 1 platform fetch.
 */

import type { OAuthTokenResponse } from "@appstrate/core/sidecar-types";

export type CachedToken = OAuthTokenResponse & { fetchedAt: number };

/** Signaled when the platform returns 410 (`needsReconnection=true`). */
export class NeedsReconnectionError extends Error {
  constructor(public readonly credentialId: string) {
    super(`OAuth credential ${credentialId} needs reconnection`);
    this.name = "NeedsReconnectionError";
  }
}

export const CACHE_TTL_MS = 30_000;

export interface OAuthTokenCacheDeps {
  /**
   * Returns the current platform API base URL. Wrapped in a getter for
   * consistency with the live `config` object (which is mutable in tests).
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
   * credential. Concurrent calls for the same `credentialId` share a
   * single in-flight promise.
   */
  async getToken(credentialId: string): Promise<CachedToken> {
    const cached = this.cache.get(credentialId);
    if (cached && this.isFresh(cached)) {
      return cached;
    }

    const inflight = this.inflight.get(credentialId);
    if (inflight) return inflight;

    const promise = this.fetchAndStore(credentialId).finally(() => {
      this.inflight.delete(credentialId);
    });
    this.inflight.set(credentialId, promise);
    return promise;
  }

  /**
   * Drop the cached token for the given credential. Called from the
   * `/llm/*` 401-retry path to force the next `getToken()` to round-trip
   * to the platform.
   */
  invalidate(credentialId: string): void {
    this.cache.delete(credentialId);
  }

  /**
   * Force a token refresh (calls the platform's refresh endpoint) and
   * replace the cached entry. Used by the 401-retry path.
   */
  async forceRefresh(credentialId: string): Promise<CachedToken> {
    // Coalesce with any in-flight read so that a refresh during a fetch
    // doesn't double-call the platform.
    const existing = this.inflight.get(credentialId);
    if (existing) return existing;

    const promise = this.callRefresh(credentialId)
      .then((fresh) => {
        const entry = this.toCached(fresh);
        this.cache.set(credentialId, entry);
        return entry;
      })
      .finally(() => {
        this.inflight.delete(credentialId);
      });
    this.inflight.set(credentialId, promise);
    return promise;
  }

  private isFresh(entry: CachedToken): boolean {
    const now = Date.now();
    if (now - entry.fetchedAt >= CACHE_TTL_MS) return false;
    if (entry.expiresAt === null) return false;
    // Belt-and-suspenders: don't serve an expired token even if it's
    // within the cache TTL window. The platform's read endpoint refreshes
    // proactively, so this branch is unreachable in practice — kept as a
    // last-resort guardrail against clock skew or platform bugs.
    if (entry.expiresAt <= now) return false;
    return true;
  }

  private async fetchAndStore(credentialId: string): Promise<CachedToken> {
    // Trust the platform's read endpoint — it already proactively
    // refreshes when the token is within `OAUTH_REFRESH_LEAD_MS` of
    // expiry. The sidecar's only refresh path is reactive via
    // `forceRefresh()` on 401.
    const fresh = await this.callRead(credentialId);
    const entry = this.toCached(fresh);
    this.cache.set(credentialId, entry);
    return entry;
  }

  private toCached(payload: OAuthTokenResponse): CachedToken {
    return {
      ...payload,
      fetchedAt: Date.now(),
    };
  }

  private async callRead(credentialId: string): Promise<OAuthTokenResponse> {
    const url = `${this.deps.getPlatformApiUrl()}/internal/oauth-token/${encodeURIComponent(credentialId)}`;
    const res = await this.fetchFn(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${this.deps.getRunToken()}` },
    });
    return this.parsePlatformResponse(res, credentialId);
  }

  private async callRefresh(credentialId: string): Promise<OAuthTokenResponse> {
    const url = `${this.deps.getPlatformApiUrl()}/internal/oauth-token/${encodeURIComponent(credentialId)}/refresh`;
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.deps.getRunToken()}` },
    });
    return this.parsePlatformResponse(res, credentialId);
  }

  private async parsePlatformResponse(
    res: Response,
    credentialId: string,
  ): Promise<OAuthTokenResponse> {
    if (res.status === 410) {
      throw new NeedsReconnectionError(credentialId);
    }
    if (!res.ok) {
      let detail = "";
      try {
        const body = (await res.json()) as { detail?: string };
        if (body.detail) detail = body.detail;
      } catch {
        // ignore parse failures
      }
      throw new Error(detail || `OAuth token endpoint returned ${res.status} for ${credentialId}`);
    }
    return (await res.json()) as OAuthTokenResponse;
  }
}
