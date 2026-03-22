/**
 * Request-Id middleware — generates a unique `req_` prefixed ID for every request.
 * Sets the `Request-Id` response header and stores `requestId` in Hono context.
 */

import type { Context, Next } from "hono";
import type { AppEnv } from "../types/index.ts";

/**
 * Generates a `req_` prefixed request ID using crypto.randomUUID(),
 * stores it in Hono context, and adds the `Request-Id` response header.
 */
export function requestId() {
  return async (c: Context<AppEnv>, next: Next) => {
    const id = `req_${crypto.randomUUID()}`;
    c.set("requestId", id);
    await next();
    c.header("Request-Id", id);
  };
}
