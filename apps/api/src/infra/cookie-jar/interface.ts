// SPDX-License-Identifier: Apache-2.0

/**
 * Credential-proxy cookie jar — per-session storage of the cookies upstreams
 * set across successive `proxyCall()` invocations sharing one `X-Session-Id`.
 *
 * Implementations: in-memory `Map` (single-instance, Tier 0/1) and a
 * Redis-backed store via the shared {@link KeyValueCache} (multi-instance,
 * Tier 2+). Both expose the exact same contract.
 *
 * One entry per `(sessionId, integrationKey)`: the integration's whole
 * {@link CookieJar}, bucketed by capture origin (see `cookieBucketKey`).
 */

import type { CookieJar } from "@appstrate/afps-runtime/resolvers";

export interface CookieJarStore {
  /** Read an integration's jar within a session. Returns an empty jar when absent. */
  get(sessionId: string, integrationKey: string): Promise<CookieJar>;
  /** Replace an integration's jar within a session. Resets the TTL. */
  set(sessionId: string, integrationKey: string, jar: CookieJar, ttlSeconds: number): Promise<void>;
  /** Release all resources (timers, connections). */
  shutdown(): Promise<void>;
}
