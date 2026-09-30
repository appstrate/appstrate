// SPDX-License-Identifier: Apache-2.0

/**
 * RFC 9209 `Proxy-Status` for the platform's proxies (credential proxy, LLM proxy): a caller
 * tells a relayed upstream response (`received-status`) from one the proxy produced itself
 * (`error`), whatever the status code — an upstream 401 is not the caller's key being refused.
 */

import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../types/index.ts";

/** This intermediary's member name in `Proxy-Status`. */
const PROXY_NAME = "appstrate";

/** RFC 9209 §2.3 proxy error types the platform emits. */
export type ProxyErrorType =
  | "http_request_denied"
  | "destination_ip_prohibited"
  | "dns_error"
  | "destination_unavailable"
  | "http_response_timeout"
  | "proxy_internal_response"
  | "proxy_internal_error";

export function relayedProxyStatus(receivedStatus: number): string {
  return `${PROXY_NAME}; received-status=${receivedStatus}`;
}

export function proxyErrorStatus(type: ProxyErrorType): string {
  return `${PROXY_NAME}; error=${type}`;
}

/** This proxy's member: the LAST one (RFC 9209 §2 — each intermediary appends its own). */
function ownMember(headers: Headers): string | null {
  const value = headers.get("proxy-status");
  const last = value?.split(",").pop()?.trim();
  return last && (last === PROXY_NAME || last.startsWith(`${PROXY_NAME};`)) ? last : null;
}

/** The response is an upstream's, relayed: its status and challenges are not the platform's. */
export function isRelayedResponse(headers: Headers): boolean {
  return /;\s*received-status=/.test(ownMember(headers) ?? "");
}

/**
 * Marks every response of a proxy route that did not mark itself: a refusal the proxy produced
 * (`proxy_internal_response`), its own failure (`proxy_internal_error`), or a response it served
 * without contacting the upstream (a cache hit: the bare member).
 */
export function proxyStatusMarker(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();
    if (ownMember(c.res.headers)) return;
    const headers = new Headers(c.res.headers);
    const status = c.res.status;
    headers.append(
      "Proxy-Status",
      status >= 500
        ? proxyErrorStatus("proxy_internal_error")
        : status >= 400
          ? proxyErrorStatus("proxy_internal_response")
          : PROXY_NAME,
    );
    c.res = new Response(c.res.body, {
      status: c.res.status,
      statusText: c.res.statusText,
      headers,
    });
  };
}
