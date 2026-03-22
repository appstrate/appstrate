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
  const requestId: string = c.get("requestId") ?? "req_unknown";

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

  // Use new Response() to set application/problem+json — c.json() forces application/json.
  return new Response(JSON.stringify(body), {
    status: body.status,
    headers: {
      "Content-Type": "application/problem+json",
      "Request-Id": requestId,
    },
  });
}
