// SPDX-License-Identifier: Apache-2.0

/**
 * Error handler middleware — catches ApiError and returns RFC 9457 Problem Details.
 * Non-ApiError exceptions are logged and converted to a generic 500.
 */

import type { Context } from "hono";
import type { AppEnv } from "../types/index.ts";
import { ApiError, internalError } from "../lib/errors.ts";
import { logger } from "../lib/logger.ts";

/**
 * Hono `app.onError` handler. Converts errors to `application/problem+json` responses.
 */
export function errorHandler(err: Error, c: Context<AppEnv>): Response {
  const requestId: string = c.get("requestId");

  let apiError: ApiError;
  if (err instanceof ApiError) {
    apiError = err;
  } else {
    logger.error("Unhandled error", {
      requestId,
      error: err.message,
      stack: err.stack,
    });
    apiError = internalError();
  }

  const body = apiError.toProblemDetail(requestId);

  // Build response headers — always include problem+json content type and request ID.
  // `Headers` (rather than a plain Record) is load-bearing: `Set-Cookie` is the
  // one HTTP header that legitimately repeats, and only `headers.append()`
  // preserves multiple values. The auth pipeline sets Set-Cookie before
  // throwing 401 (to bury a stale BA cookie); a Record would coalesce those
  // into a single value and the browser would silently keep the bad cookie.
  const headers = new Headers({
    "Content-Type": "application/problem+json",
    "Request-Id": requestId,
  });

  // Merge custom headers from ApiError (e.g. rate-limit headers on 429).
  if (apiError.headers) {
    for (const [name, value] of Object.entries(apiError.headers)) {
      headers.set(name, value);
    }
  }

  // Preserve any Set-Cookie headers attached to `c.res` before the throw —
  // Hono's `setCookie`/`deleteCookie` write through `c.res.headers`, but the
  // error path builds a fresh `Response` and would otherwise drop them.
  const preThrowResHeaders: Headers | undefined = c.res?.headers;
  if (preThrowResHeaders) {
    for (const cookie of preThrowResHeaders.getSetCookie()) {
      headers.append("Set-Cookie", cookie);
    }
  }

  // Use new Response() to set application/problem+json — c.json() forces application/json.
  return new Response(JSON.stringify(body), {
    status: body.status,
    headers,
  });
}
