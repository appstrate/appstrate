// SPDX-License-Identifier: Apache-2.0

/**
 * Captures the socket-level client IP from `getConnInfo(c)` and stores it
 * in the per-Request map exposed by `lib/client-ip.ts`. Without this
 * middleware, `getClientIpFromRequest` (used inside Better Auth plugin
 * endpoints which only see the bare `Request`) falls back to `"unknown"`
 * whenever `TRUST_PROXY=false` and no forwarded header is present — the
 * normal case for direct/local deployments.
 *
 * Mounted globally near the top of the chain (right after `requestId`) so
 * the entire request lifecycle benefits — including downstream BA
 * endpoints, route handlers, and rate limiters that share the same
 * `Request` instance.
 */

import type { MiddlewareHandler } from "hono";
import { getConnInfo } from "hono/bun";
import { setRequestClientIp } from "../lib/client-ip.ts";

export function clientIp(): MiddlewareHandler {
  return async (c, next) => {
    try {
      const addr = getConnInfo(c).remote.address;
      if (addr) setRequestClientIp(c.req.raw, addr);
    } catch {
      // No conn info available (e.g. test harness using `app.request()`).
      // Leave the map untouched — downstream falls back to `"unknown"`.
    }
    await next();
  };
}
