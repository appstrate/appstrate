// SPDX-License-Identifier: Apache-2.0

/**
 * Credential-proxy session binding — pins an X-Session-Id to the first
 * principal that used it, for the session TTL. Subsequent requests carrying
 * the same session id MUST come from the same principal.
 *
 * A **principal** is whatever identity the auth pipeline resolved the call
 * with — an API key (headless / GitHub Action flow) or a bearer JWT user
 * (interactive CLI device-flow). Callers pass a namespaced identifier
 * (`apikey:<id>`, `user:<id>`) so the two identity kinds can never collide
 * on the same bucket.
 *
 * Prevents a low-privilege principal within the same organisation from
 * piggy-backing on another principal's cookie jar (OAuth flow hijack). The
 * store is Redis when configured, in-memory otherwise — same KeyValueCache
 * abstraction used by idempotency.
 *
 * The format is strictly UUID v4: the header is dev-supplied and a weak
 * format (sequential ids, user-controlled strings) would let an attacker
 * guess another user's session. UUID v4 gives 122 bits of entropy.
 */

import { getCache } from "../../infra/index.ts";

/** RFC 4122 v4 — 8-4-4-4-12 hex with nibble constraints on the 13th and 17th chars. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidSessionId(sessionId: string): boolean {
  return UUID_V4.test(sessionId);
}

export type SessionBindResult =
  | { kind: "bound" }
  | { kind: "reused" }
  | { kind: "mismatch"; boundTo: string };

/**
 * Atomically bind a session to a principal, or confirm a pre-existing
 * binding. Returns:
 *   - `bound`      — fresh binding, session was unknown
 *   - `reused`     — same principal had already bound this session
 *   - `mismatch`   — another principal owns the session → caller MUST 403
 *
 * `principalId` is expected to be a namespaced string such as
 * `apikey:<id>` or `user:<id>` so API-key and JWT-user identities can't
 * collide on the same bucket even when their underlying IDs happen to match.
 */
export async function bindOrCheckSession(
  sessionId: string,
  principalId: string,
  ttlSeconds: number,
): Promise<SessionBindResult> {
  const cache = await getCache();
  const key = `cp:session:${sessionId}`;
  const setNx = await cache.set(key, principalId, { ttlSeconds, nx: true });
  if (setNx) return { kind: "bound" };

  const existing = await cache.get(key);
  if (existing === principalId) return { kind: "reused" };
  return { kind: "mismatch", boundTo: existing ?? "unknown" };
}
