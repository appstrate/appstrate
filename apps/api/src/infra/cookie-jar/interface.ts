// SPDX-License-Identifier: Apache-2.0

/**
 * Credential-proxy cookie jar — per-session persistent cookie storage
 * across successive `proxyCall()` invocations. Needed for multi-step OAuth
 * flows where an integration's first response sets a session cookie that
 * subsequent calls must carry back.
 *
 * Implementations: in-memory `Map` (single-instance, Tier 0/1) and a
 * Redis-backed store via the shared {@link KeyValueCache} (multi-instance,
 * Tier 2+ — no loss on round-robin load balancers during an in-progress
 * OAuth flow). Both expose the exact same contract; callers cannot tell
 * which backing store they are talking to.
 *
 * Keyed by `(sessionId, connectionId)` since a single X-Session-Id can drive
 * calls across several connections, each with its own cookie scope.
 */

export interface CookieJarStore {
  /** Read cookies for a connection within a session. Returns [] when absent. */
  get(sessionId: string, connectionId: string): Promise<string[]>;
  /** Replace cookies for a connection within a session. Resets the TTL. */
  set(
    sessionId: string,
    connectionId: string,
    cookies: string[],
    ttlSeconds: number,
  ): Promise<void>;
  /** Release all resources (timers, connections). */
  shutdown(): Promise<void>;
}
