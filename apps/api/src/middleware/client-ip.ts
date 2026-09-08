// SPDX-License-Identifier: Apache-2.0

/**
 * Resolves the client IP once, at the edge, and makes that one answer the only
 * one anything downstream can see.
 *
 * Two carriers, because downstream code reaches the request in two shapes:
 *
 *  - the per-Request map in `lib/client-ip.ts`, fed from
 *    `getConnInfo(c).remote.address`, for code that only sees the bare
 *    `Request` (Better Auth plugin endpoints, the OIDC strategy) and would
 *    otherwise resolve `null` whenever `TRUST_PROXY=false` and no forwarded
 *    header is present — the normal case for direct/local deployments;
 *  - `CLIENT_IP_HEADER` on the inbound `Request` itself, which Better Auth
 *    reads (`advanced.ipAddress.ipAddressHeaders`, `packages/db/src/auth.ts`)
 *    for its rate limiter and its `session.ipAddress` records.
 *
 * Any inbound value of that header is dropped before the platform's own answer
 * is written, so a caller cannot state its address. Stamping HERE rather than
 * at the `getAuth().handler` mount is what makes that hold everywhere: the
 * dozens of `getAuth().api.*` calls that hand Better Auth `c.req.raw.headers`
 * directly get the same guarantee, for free, instead of each needing to
 * remember it.
 *
 * Mounted globally near the top of the chain (right after `requestId`) so the
 * entire request lifecycle benefits — downstream BA endpoints, route handlers,
 * and rate limiters all share the same `Request` instance.
 */

import type { MiddlewareHandler } from "hono";
import { getConnInfo } from "hono/bun";
import { CLIENT_IP_HEADER, getClientIp, setRequestClientIp } from "../lib/client-ip.ts";

export function clientIp(): MiddlewareHandler {
  return async (c, next) => {
    try {
      const addr = getConnInfo(c).remote.address;
      if (addr) setRequestClientIp(c.req.raw, addr);
    } catch {
      // No conn info available (e.g. the test harness using `app.request()`).
      // Leave the map untouched — downstream falls back to `null`.
    }
    c.req.raw.headers.delete(CLIENT_IP_HEADER);
    const ip = getClientIp(c);
    if (ip !== "unknown") c.req.raw.headers.set(CLIENT_IP_HEADER, ip);
    await next();
  };
}
