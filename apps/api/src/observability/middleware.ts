// SPDX-License-Identifier: Apache-2.0

/**
 * HTTP server-span middleware. Wraps each request in an OTel `SERVER` span
 * parented from the inbound W3C `traceparent` (reusing the same header the
 * request-id middleware already validates), and records the response status.
 *
 * Registered right after `requestId` so the span — and its bound logger trace
 * context — covers the full handler chain. When observability is disabled the
 * middleware is a straight pass-through (`next()`), adding nothing to the hot
 * path.
 */

import type { Context, Next } from "hono";
import { SpanKind } from "@opentelemetry/api";
import { isObservabilityEnabled, runWithSpan, currentSpan } from "./otel.ts";
import type { AppEnv } from "../types/index.ts";

export function observability() {
  return async (c: Context<AppEnv>, next: Next) => {
    if (!isObservabilityEnabled()) return next();

    const method = c.req.method;
    const route = c.req.routePath || new URL(c.req.url).pathname;

    return runWithSpan(
      `${method} ${route}`,
      {
        kind: SpanKind.SERVER,
        traceparent: c.req.header("traceparent"),
        attributes: {
          "http.request.method": method,
          "http.route": route,
          "url.path": new URL(c.req.url).pathname,
        },
      },
      async () => {
        await next();
        currentSpan()?.setAttribute("http.response.status_code", c.res.status);
      },
    );
  };
}
