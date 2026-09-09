// SPDX-License-Identifier: Apache-2.0

/**
 * Resolves the client IP once, at the edge: the socket address (`getConnInfo`)
 * goes into the per-Request map of `lib/client-ip.ts`, and the
 * platform-resolved address into `CLIENT_IP_HEADER` on the inbound `Request`,
 * any inbound value of that header being dropped first.
 *
 * The ONLY writer of that header, so every downstream reader — `getAuth()`'s
 * handler and every `auth.api.*` call handed `c.req.raw.headers` — inherits
 * the platform's answer.
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
