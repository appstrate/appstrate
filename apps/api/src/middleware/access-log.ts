// SPDX-License-Identifier: Apache-2.0

/**
 * Access log — one `debug` line per request: method, matched route, status,
 * duration and the `Request-Id` the client was handed, so a report quoting that
 * id can be matched to what the server did. Off at the default
 * `LOG_LEVEL=info`; `LOG_LEVEL=debug` turns it on.
 *
 * The matched route PATTERN, never the request path or its query string: both
 * carry bearer tokens (`/invite/:token/accept`, Better Auth's
 * `/api/auth/reset-password/<token>` behind the `/api/auth/*` catch-all, the
 * signed `?token=` of preview and upload URLs). A wildcard match is therefore
 * logged as its pattern, tail unknown — the price of never writing a secret.
 *
 * `durationMs` runs until the handler returns its response: for an SSE or any
 * other streamed body that is time-to-headers, not the life of the stream.
 */

import type { Context, Next } from "hono";
import { routePath } from "hono/route";
import type { Logger } from "@appstrate/core/logger";
import type { AppEnv } from "../types/index.ts";
import { logger } from "../lib/logger.ts";

/**
 * Mount after `requestId()` (it reads the id) and `telemetry()` (so the line is
 * written inside the request's trace context).
 */
export function accessLog(log: Logger = logger) {
  return async (c: Context<AppEnv>, next: Next) => {
    const start = performance.now();
    // A handler that throws is answered by `app.onError` before `next()`
    // resolves, so `c.res` is the final response on every path.
    await next();
    log.debug("request", {
      requestId: c.get("requestId"),
      method: c.req.method,
      // Resolved only now: while this frame is the one running, the route in
      // scope is its own `*` (same rule as the telemetry span name).
      route: routePath(c),
      status: c.res.status,
      durationMs: Math.round(performance.now() - start),
    });
  };
}
