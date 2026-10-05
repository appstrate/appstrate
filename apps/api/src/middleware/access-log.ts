// SPDX-License-Identifier: Apache-2.0

/**
 * Access log — one `debug` line per request: method, path, status, duration and
 * the `Request-Id` the client was handed, so a report quoting that id can be
 * matched to what the server did. Off at the default `LOG_LEVEL=info`;
 * `LOG_LEVEL=debug` turns it on.
 *
 * The path only, never the query string: preview and upload URLs carry their
 * signed token there.
 */

import type { Context, Next } from "hono";
import type { Logger } from "@appstrate/core/logger";
import type { AppEnv } from "../types/index.ts";
import { logger } from "../lib/logger.ts";

/** Mount right after `requestId()`: it reads the id that middleware sets. */
export function accessLog(log: Logger = logger) {
  return async (c: Context<AppEnv>, next: Next) => {
    const start = performance.now();
    // A handler that throws is answered by `app.onError` before `next()`
    // resolves, so `c.res` is the final response on every path.
    await next();
    log.debug("request", {
      requestId: c.get("requestId"),
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs: Math.round(performance.now() - start),
    });
  };
}
