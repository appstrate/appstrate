// SPDX-License-Identifier: Apache-2.0

/**
 * HTTP server-span middleware. Wraps each request in an OTel `SERVER` span and
 * records the matched route template + response status.
 *
 * Contributed to the platform via {@link TelemetryProvider.httpMiddleware} —
 * the core global telemetry middleware (registered right after `requestId`)
 * delegates here, so the span — and its bound logger trace context — covers
 * the full handler chain. When observability is disabled the middleware is a
 * straight pass-through (`next()`), adding nothing to the hot path.
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
import { readOtelEnv } from "./env.ts";
import { isObservabilityEnabled, runWithSpan, currentSpan } from "./otel.ts";

export interface ObservabilityMiddlewareDeps {
  /**
   * Client-IP resolver honoring the platform's `TRUST_PROXY` semantics —
   * injected from `ctx.services.http.clientIp` at module init (the resolver
   * lives in the platform, not in this module).
   */
  clientIp: (c: Context) => string;
}

/** Resolve the matched route template, defensively — never throw post-response. */
function resolveRouteTemplate(c: Context): string {
  try {
    return routePath(c);
  } catch {
    return "";
  }
}

export function observability(deps: ObservabilityMiddlewareDeps) {
  // Read the trust flag once at construction (module init — env is stable
  // for the process lifetime). Untrusted by default — see the module doc above.
  const trustInbound = readOtelEnv().trustIncomingTrace;

  return async (c: Context, next: Next) => {
    if (!isObservabilityEnabled()) return next();

    const method = c.req.method;
    const url = new URL(c.req.url);
    // Resolved socket/forwarded client IP (honors TRUST_PROXY). The resolver
    // returns the "unknown" sentinel when nothing resolves (e.g. the test
    // harness has no conn info) — omit the attribute rather than record it.
    // NOTE: `network.protocol.version` is deliberately absent — Bun/Hono hand
    // the handler a fetch `Request`, which does not expose the negotiated HTTP
    // version, and semconv forbids guessing it.
    const clientAddress = deps.clientIp(c);

    return runWithSpan(
      // Provisional, low-cardinality name — overwritten with `<METHOD> <template>`
      // after next() resolves the matched route. Never embeds the raw path (the
      // raw path lives only in the `url.path` attribute) so scanners spraying
      // distinct paths can't explode the span-name cardinality.
      method,
      {
        kind: SpanKind.SERVER,
        traceparent: trustInbound ? c.req.header("traceparent") : undefined,
        attributes: {
          "http.request.method": method,
          "url.path": url.pathname,
          // Required by OTel HTTP server semconv. Derived from the request URL
          // (the scheme the server saw — no forwarded-proto guessing).
          "url.scheme": url.protocol.replace(/:$/, ""),
          // Recommended: the Host the client targeted (no port — that's
          // `server.port`, which we don't emit). Low-cardinality.
          ...(url.hostname !== "" ? { "server.address": url.hostname } : {}),
          ...(clientAddress !== "unknown" ? { "client.address": clientAddress } : {}),
        },
      },
      async () => {
        await next();

        const span = currentSpan();
        if (!span) return;

        // A resolved template is a low-cardinality string (`/x/:id`); the
        // wildcard or an empty result means no route matched (404). Per OTel
        // HTTP semconv, when there is no low-cardinality route the SERVER span
        // name is just `{method}` — never the raw path (that would let scanners
        // spray unbounded distinct span names). The raw path stays in `url.path`.
        const matched = resolveRouteTemplate(c);
        const isTemplate = matched !== "" && matched !== "*" && matched !== "/*";

        span.updateName(isTemplate ? `${method} ${matched}` : method);
        if (isTemplate) span.setAttribute("http.route", matched);
        span.setAttribute("http.response.status_code", c.res.status);

        // `app.onError` resolves thrown route errors before runWithSpan's
        // exception path sees them, so a 500 would otherwise leave the SERVER
        // span UNSET. Map any 5xx response to an ERROR span status, and set
        // `error.type` (semconv: Conditionally Required on error) — the escaped
        // exception's class name when one was caught by `app.onError` (Hono
        // stashes it on `c.error`), else the status code as a string (the
        // semconv-sanctioned value for non-exception HTTP errors). Both are
        // low-cardinality (error classes are bounded by the codebase).
        if (c.res.status >= 500) {
          span.setStatus({ code: SpanStatusCode.ERROR });
          span.setAttribute(
            "error.type",
            c.error ? c.error.constructor.name || c.error.name : String(c.res.status),
          );
        }

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
