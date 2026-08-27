// SPDX-License-Identifier: Apache-2.0

/**
 * Error handler middleware — catches ApiError and returns RFC 9457 Problem Details.
 * Non-ApiError exceptions are logged and converted to a generic 500.
 */

import type { Context } from "hono";
import type { AppEnv } from "../types/index.ts";
import { ApiError, internalError } from "../lib/errors.ts";
import { formatErrorChain } from "@appstrate/core/errors";
import type { Logger } from "@appstrate/core/logger";
import { logger } from "../lib/logger.ts";

/**
 * Hono `app.onError` handler. Converts errors to `application/problem+json` responses.
 *
 * @param log - The logger to write to. Defaults to the platform logger, so
 *   `app.onError(errorHandler)` still type-checks and behaves identically; the
 *   parameter exists because what this handler does with a `cause` is now a
 *   testable claim, and the only alternative — reading the real pino line back
 *   off `process.stdout` — is banned repo-wide (`no-restricted-syntax`: one
 *   process runs every suite, so a global capture collects other suites' output
 *   and fails non-deterministically, issue #1180).
 */
export function errorHandler(err: Error, c: Context<AppEnv>, log: Logger = logger): Response {
  const requestId: string = c.get("requestId");

  let apiError: ApiError;
  if (err instanceof ApiError) {
    apiError = err;
    // An ApiError raised from a `catch` carries the underlying failure as
    // `cause`, and this is its ONLY outlet: the problem body below renders
    // `detail` and never the chain (see the log-vs-body note on
    // `ApiError.cause`). Emitted only when there is a cause — the routine
    // 404/400 has none and must not add a line to every request's log.
    if (err.cause !== undefined && err.cause !== null) {
      // `error`, not a level derived from `status`. A cause is only present
      // because a `catch` translated something the server did not expect —
      // that is a server-side event worth an error line even when the status
      // it produces is a 4xx the client caused (a 400 `delete_failed` whose
      // cause is a DB constraint violation is the shape).
      log.error("Request failed", {
        requestId,
        code: err.code,
        status: err.status,
        error: formatErrorChain(err),
        stack: err.stack,
      });
    }
  } else {
    log.error("Unhandled error", {
      requestId,
      // `formatErrorChain`, not `err.message`: V8 builds `.stack` at
      // construction and never walks `cause`, so neither field below carried
      // any trace of a threaded chain. Identical output when there is no
      // cause, so no existing log line changes shape.
      error: formatErrorChain(err),
      stack: err.stack,
    });
    apiError = internalError();
  }

  // The response body. `toProblemDetail` reads `message`, never `cause` — the
  // chain stays in the log above. For a non-ApiError it is `internalError()`,
  // whose detail is the fixed string "An internal error occurred", so an
  // unhandled failure leaks nothing at all.
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
