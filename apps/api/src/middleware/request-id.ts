// SPDX-License-Identifier: Apache-2.0

/**
 * Request-Id middleware — generates a unique `req_` prefixed ID for every request.
 * Sets the `Request-Id` response header and stores `requestId` in Hono context.
 *
 * Also extracts and validates the inbound W3C `traceparent` header (RFC editor
 * draft / W3C Trace Context Recommendation). When present and well-formed,
 * the header is forwarded back to the response and surfaced on the Hono
 * context as `traceparent` + `traceId` so downstream handlers can include
 * the trace-id in their structured-log bindings. Malformed headers are
 * silently dropped — never echoed back, never logged — so a broken upstream
 * cannot pollute the trace correlation surface.
 */

import type { Context, Next } from "hono";
import { parseTraceparent } from "@appstrate/afps-runtime/transport";
import type { AppEnv } from "../types/index.ts";

/**
 * Generates a `req_` prefixed request ID using crypto.randomUUID(),
 * stores it in Hono context, and adds the `Request-Id` response header.
 * Also propagates the inbound W3C `traceparent` header to context +
 * response when valid.
 */
export function requestId() {
  return async (c: Context<AppEnv>, next: Next) => {
    const id = `req_${crypto.randomUUID()}`;
    c.set("requestId", id);

    const inbound = c.req.header("traceparent");
    const trace = parseTraceparent(inbound);
    if (trace) {
      c.set("traceparent", inbound);
      c.set("traceId", trace.traceId);
    }

    await next();

    c.header("Request-Id", id);
    if (trace && inbound) {
      // Echo the validated header back so a curl --verbose round-trip
      // confirms the platform participates in the trace. Routes that
      // make their own outbound calls should use parseTraceparent +
      // nextTraceContext to mint a child span — the response echo is
      // observability, not propagation.
      c.header("traceparent", inbound);
    }
  };
}
