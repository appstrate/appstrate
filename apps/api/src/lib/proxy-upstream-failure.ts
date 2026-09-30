// SPDX-License-Identifier: Apache-2.0

import { ApiError } from "./errors.ts";
import { proxyErrorStatus, type ProxyErrorType } from "./proxy-status.ts";

/** A proxy's upstream that could not be resolved, reached, or did not answer in time. */
export type UpstreamFailureCode =
  "upstream_unresolvable" | "upstream_unreachable" | "upstream_timeout";

/** Status, problem title and RFC 9209 §2.3 error type of each upstream failure, on every proxy. */
export const UPSTREAM_FAILURES: Record<
  UpstreamFailureCode,
  { status: number; title: string; proxyError: ProxyErrorType }
> = {
  upstream_unresolvable: { status: 502, title: "Upstream Unresolvable", proxyError: "dns_error" },
  upstream_unreachable: {
    status: 502,
    title: "Upstream Unreachable",
    proxyError: "destination_unavailable",
  },
  upstream_timeout: { status: 504, title: "Upstream Timeout", proxyError: "http_response_timeout" },
};

/** The problem a proxy answers for an upstream failure; `detail` never names a secret. */
export function upstreamFailure(code: UpstreamFailureCode, detail: string): ApiError {
  const failure = UPSTREAM_FAILURES[code];
  return new ApiError({
    status: failure.status,
    code,
    title: failure.title,
    detail,
    headers: { "Proxy-Status": proxyErrorStatus(failure.proxyError) },
  });
}
