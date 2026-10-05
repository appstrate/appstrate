// SPDX-License-Identifier: Apache-2.0

/**
 * Access log. Writes the matched route PATTERN, never the path or query string:
 * both carry bearer tokens (`/invite/:token/accept`, `/api/auth/reset-password/<token>`,
 * signed `?token=` URLs). `durationMs` is time-to-headers for a streamed response.
 */

import type { Context, Next } from "hono";
import { routePath } from "hono/route";
import type { Logger } from "@appstrate/core/logger";
import type { AppEnv } from "../types/index.ts";
import { logger } from "../lib/logger.ts";

export function accessLog(log: Logger = logger) {
  return async (c: Context<AppEnv>, next: Next) => {
    const start = performance.now();
    await next();
    log.debug("request", {
      requestId: c.get("requestId"),
      method: c.req.method,
      route: routePath(c),
      status: c.res.status,
      durationMs: Math.round(performance.now() - start),
    });
  };
}
