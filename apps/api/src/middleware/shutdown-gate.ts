// SPDX-License-Identifier: Apache-2.0

/**
 * Shutdown gate — rejects new POSTs with 503 while the process drains.
 *
 * Shared by BOTH HTTP listeners (the main app in `index.ts` and the
 * guest-facing sink listener in `lib/sink-server.ts`) so draining behavior
 * never depends on which port a caller targets. The flag is read through a
 * callback because it flips after the middleware is installed (see
 * `createShutdownHandler`'s `setShuttingDown` in `lib/shutdown.ts`).
 */

import type { Context, Next } from "hono";
import { ApiError } from "../lib/errors.ts";
import type { AppEnv } from "../types/index.ts";

/** Reject POSTs with 503 problem+json while `isShuttingDown()` is true. */
export function shutdownGate(isShuttingDown: () => boolean) {
  return async (c: Context<AppEnv>, next: Next) => {
    if (isShuttingDown() && c.req.method === "POST") {
      throw new ApiError({
        status: 503,
        code: "shutting_down",
        title: "Service Unavailable",
        detail: "Server is shutting down",
      });
    }
    return next();
  };
}
