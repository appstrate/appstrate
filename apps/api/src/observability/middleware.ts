// SPDX-License-Identifier: Apache-2.0

/**
 * HTTP server-span middleware. Wraps each request in an OTel `SERVER` span and
 * records the matched route template + response status.
 *
 * Registered right after `requestId` so the span — and its bound logger trace
 * context — covers the full handler chain. When observability is disabled the
 * middleware is a straight pass-through (`next()`), adding nothing to the hot
 * path.
 *
 * Route template resolution happens AFTER `await next()`: while the global
 * `app.use("*")` frame is still on the stack the only route in scope is the
 * wildcard `*`, so reading the template up front collapses every span to
 * `GET /*`. After the chain runs, `routePath(c)` returns the actual matched
 * template (e.g. `/api/agents/:scope/:name/run`).
 *
 * Inbound `traceparent` trust is gated behind `OTEL_TRUST_INCOMING_TRACE`
 * (default off): a public-facing API must not let an unauthenticated caller
 * splice the server span into an attacker-chosen trace. When untrusted we still
 * emit a SERVER span — we just start a fresh root instead of parenting it from
 * the unverified header.
 */

import type { Context, Next } from "hono";
import { routePath } from "hono/route";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { getEnv } from "@appstrate/env";
import { isObservabilityEnabled, runWithSpan, currentSpan } from "./otel.ts";
import type { AppEnv } from "../types/index.ts";

/** Resolve the matched route template, defensively — never throw post-response. */
function resolveRouteTemplate(c: Context<AppEnv>): string {
  try {
    return routePath(c);
  } catch {
    return "";
  }
}

export function observability() {
  // Read the trust flag once at registration (env is cached + already
  // validated at boot). Untrusted by default — see the module doc above.
  const trustInbound = getEnv().OTEL_TRUST_INCOMING_TRACE;

  return async (c: Context<AppEnv>, next: Next) => {
    if (!isObservabilityEnabled()) return next();

    const method = c.req.method;
    const pathname = new URL(c.req.url).pathname;

    return runWithSpan(
      // Provisional name — overwritten with the matched template after next().
      `${method} ${pathname}`,
      {
        kind: SpanKind.SERVER,
        traceparent: trustInbound ? c.req.header("traceparent") : undefined,
        attributes: {
          "http.request.method": method,
          "url.path": pathname,
        },
      },
      async () => {
        await next();

        const span = currentSpan();
        if (!span) return;

        // A resolved template is a low-cardinality string (`/x/:id`); the
        // wildcard or an empty result means no route matched (404) — fall back
        // to the raw pathname for the span NAME, but never tag `http.route`
        // with the high-cardinality raw path.
        const matched = resolveRouteTemplate(c);
        const isTemplate = matched !== "" && matched !== "*" && matched !== "/*";

        span.updateName(`${method} ${isTemplate ? matched : pathname}`);
        if (isTemplate) span.setAttribute("http.route", matched);
        span.setAttribute("http.response.status_code", c.res.status);

        // `app.onError` resolves thrown route errors before runWithSpan's
        // exception path sees them, so a 500 would otherwise leave the SERVER
        // span UNSET. Map any 5xx response to an ERROR span status.
        if (c.res.status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });

        // SSE / streaming responses: the span ends when the handler RETURNS its
        // streaming Response (time-to-first-byte), not when the stream closes.
        // Tag them so the duration is not silently mistaken for stream lifetime.
        if (c.res.headers.get("content-type")?.includes("text/event-stream")) {
          span.setAttribute("appstrate.response.streaming", true);
        }
      },
    );
  };
}
