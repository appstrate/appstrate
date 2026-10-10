// SPDX-License-Identifier: Apache-2.0

/**
 * RFC 9209 `Proxy-Status` for the platform's proxies (credential proxy, LLM proxy): a caller
 * tells a relayed upstream response (`received-status`) from one the proxy produced itself
 * (`error`), whatever the status code — an upstream 401 is not the caller's key being refused.
 */

import type { MiddlewareHandler } from "hono";
import type { ApiCallFailureCode } from "@appstrate/afps-runtime/resolvers";
import type { AppEnv } from "../types/index.ts";
import { ApiError } from "./errors.ts";

/** This intermediary's member name in `Proxy-Status`. */
const PROXY_NAME = "appstrate";

/** RFC 9209 §2.3 proxy error types the platform emits. */
type ProxyErrorType =
  | "http_request_denied"
  | "destination_ip_prohibited"
  | "dns_error"
  | "destination_unavailable"
  | "http_response_timeout"
  | "proxy_internal_response"
  | "proxy_internal_error"
  | "proxy_configuration_error";

export function relayedProxyStatus(receivedStatus: number): string {
  return `${PROXY_NAME}; received-status=${receivedStatus}`;
}

function proxyErrorStatus(type: ProxyErrorType): string {
  return `${PROXY_NAME}; error=${type}`;
}

interface ProxyProblem {
  status: number;
  title: string;
  proxyError?: ProxyErrorType;
  failure?: string;
}

/**
 * Each problem a platform proxy answers itself: status, title, the RFC 9209 §2.3 error type
 * when it is more precise than the one {@link proxyStatusMarker} appends for the status, and
 * for an upstream failure the phrase that completes its detail.
 */
const PROXY_PROBLEMS = {
  unauthorized_target: {
    status: 403,
    title: "Unauthorized Target",
    proxyError: "http_request_denied",
  },
  blocked_target: { status: 403, title: "Blocked Target", proxyError: "destination_ip_prohibited" },
  credential_exfiltration_refused: {
    status: 403,
    title: "Credential Exfiltration Refused",
    proxyError: "http_request_denied",
  },
  credential_not_found: { status: 404, title: "Credential Not Found" },
  credential_unusable: {
    status: 502,
    title: "Credential Unusable",
    proxyError: "proxy_configuration_error",
  },
  encryption_key_unavailable: {
    status: 503,
    title: "Service Unavailable",
    proxyError: "proxy_configuration_error",
  },
  unresolved_placeholder: { status: 400, title: "Unresolved Placeholder" },
  invalid_request: { status: 400, title: "Invalid Request" },
  upstream_unresolvable: {
    status: 502,
    title: "Upstream Unresolvable",
    proxyError: "dns_error",
    failure: "could not be resolved",
  },
  upstream_unreachable: {
    status: 502,
    title: "Upstream Unreachable",
    proxyError: "destination_unavailable",
    failure: "could not be reached",
  },
  upstream_timeout: {
    status: 504,
    title: "Upstream Timeout",
    proxyError: "http_response_timeout",
    failure: "did not answer in time",
  },
} as const satisfies Record<string, ProxyProblem> & Record<ApiCallFailureCode, ProxyProblem>;

export type ProxyProblemCode = keyof typeof PROXY_PROBLEMS;

/** A proxy's upstream that could not be resolved, reached, or did not answer in time. */
export type UpstreamFailureCode = Extract<ProxyProblemCode, `upstream_${string}`>;

/** `"<subject> could not be reached"` and the like: the detail of an upstream failure. */
export function upstreamFailureDetail(subject: string, code: UpstreamFailureCode): string {
  return `${subject} ${PROXY_PROBLEMS[code].failure}`;
}

/** The problem a proxy answers for `code`; `detail` never names a secret. */
export function proxyProblem(code: ProxyProblemCode, detail: string): ApiError {
  const problem: ProxyProblem = PROXY_PROBLEMS[code];
  return new ApiError({
    status: problem.status,
    code,
    title: problem.title,
    detail,
    ...(problem.proxyError
      ? { headers: { "Proxy-Status": proxyErrorStatus(problem.proxyError) } }
      : {}),
  });
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
