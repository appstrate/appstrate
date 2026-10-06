// SPDX-License-Identifier: Apache-2.0

import type { TestResult } from "@appstrate/shared-types";

/**
 * Map a `fetch()` rejection (timeout / DNS / TCP / TLS) into the structured
 * {@link TestResult} shape used by the org-models and org-proxies test
 * endpoints. Both endpoints share identical mapping rules — keep it here.
 *
 * Bun puts the errno in `code`, not always in the message: a refused
 * connection is `code: "ConnectionRefused"` with a message naming no errno.
 */
export function mapFetchErrorToTestResult(err: unknown, latency: number): TestResult {
  if (err instanceof DOMException && err.name === "TimeoutError") {
    return { ok: false, latency, error: "TIMEOUT", message: "Request timed out (10s)" };
  }
  const msg = err instanceof Error ? err.message : "Network error";
  const code: unknown = (err as { code?: unknown } | null)?.code;
  const signal = `${typeof code === "string" ? code : ""} ${msg}`;
  if (/ENOTFOUND|getaddrinfo/.test(signal)) {
    return { ok: false, latency, error: "DNS_ERROR", message: "DNS resolution failed" };
  }
  if (/ECONNREFUSED|ConnectionRefused/.test(signal)) {
    return { ok: false, latency, error: "CONNECTION_REFUSED", message: "Connection refused" };
  }
  if (/ECONNRESET|EPIPE/.test(signal)) {
    return { ok: false, latency, error: "CONNECTION_RESET", message: "Connection reset" };
  }
  if (/CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE/.test(signal)) {
    return { ok: false, latency, error: "TLS_ERROR", message: "TLS certificate error" };
  }
  return { ok: false, latency, error: "NETWORK_ERROR", message: msg };
}
