// SPDX-License-Identifier: Apache-2.0

/**
 * Credential-proxy cookie jar — per-session storage of the cookies upstreams
 * set across successive `proxyCall()` invocations sharing one `X-Session-Id`.
 *
 * Implementations: in-memory `Map` (single-instance, Tier 0/1) and a
 * Redis-backed store via the shared {@link KeyValueCache} (multi-instance,
 * Tier 2+). Both expose the exact same contract.
 *
 * One entry per `(sessionId, connectionId)`: one API-key principal can drive
 * several connections (`X-Connection-Id`, `Appstrate-User`) on one session id,
 * and each must keep its own upstream session.
 */

import type { CookieJar } from "@appstrate/afps-runtime/resolvers";

export interface CookieJarStore {
  /** Read a connection's jar within a session. Returns an empty jar when absent. */
  get(sessionId: string, connectionId: string): Promise<CookieJar>;
  /** Replace a connection's jar within a session. Resets the TTL. */
  set(sessionId: string, connectionId: string, jar: CookieJar, ttlSeconds: number): Promise<void>;
  /** Release all resources (timers, connections). */
  shutdown(): Promise<void>;
}
