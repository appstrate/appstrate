// SPDX-License-Identifier: Apache-2.0

import type { TestResult } from "@appstrate/shared-types";

/** `code` of a rejection, its own or its cause's (Node wraps the socket error, Bun does not). */
function errorCode(err: unknown): string {
  for (const candidate of [err, (err as { cause?: unknown } | null)?.cause]) {
    const code = (candidate as { code?: unknown } | null | undefined)?.code;
    if (typeof code === "string") return code;
  }
  return "";
}

/**
 * Map a `fetch()` rejection (timeout / DNS / TCP / TLS) into the structured
 * {@link TestResult} shape used by the org-models and org-proxies test
 * endpoints. Both endpoints share identical mapping rules — keep it here.
 *
 * Classified on the error `code`, with the message as a second source: Bun
 * rejects a refused connection with `code: "ConnectionRefused"` and a message
 * that names no errno at all ("Unable to connect. Is the computer able to
 * access the url?"), so a message-only match called it a generic network error.
 */
export function mapFetchErrorToTestResult(err: unknown, latency: number): TestResult {
  if (err instanceof DOMException && err.name === "TimeoutError") {
    return { ok: false, latency, error: "TIMEOUT", message: "Request timed out (10s)" };
  }
  const msg = err instanceof Error ? err.message : "Network error";
  const signal = `${errorCode(err)} ${msg}`;
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/.test(signal)) {
    return { ok: false, latency, error: "DNS_ERROR", message: "DNS resolution failed" };
  }
  if (/ECONNREFUSED|ConnectionRefused/.test(signal)) {
    return { ok: false, latency, error: "CONNECTION_REFUSED", message: "Connection refused" };
  }
  if (/ECONNRESET|EPIPE|ConnectionClosed/.test(signal)) {
    return { ok: false, latency, error: "CONNECTION_RESET", message: "Connection reset" };
  }
  if (/CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE/.test(signal)) {
    return { ok: false, latency, error: "TLS_ERROR", message: "TLS certificate error" };
  }
  return { ok: false, latency, error: "NETWORK_ERROR", message: msg };
}
