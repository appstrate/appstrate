// SPDX-License-Identifier: Apache-2.0

import type { TestResult } from "@appstrate/shared-types";

/**
 * Map a `fetch()` rejection (timeout / DNS / TCP / TLS) into the structured
 * {@link TestResult} shape used by the org-models and org-proxies test
 * endpoints. Both endpoints share identical mapping rules — keep it here.
 */
export function mapFetchErrorToTestResult(err: unknown, latency: number): TestResult {
  if (err instanceof DOMException && err.name === "TimeoutError") {
    return { ok: false, latency, error: "TIMEOUT", message: "Request timed out (10s)" };
  }
  const msg = err instanceof Error ? err.message : "Network error";
  if (msg.includes("ENOTFOUND") || msg.includes("getaddrinfo")) {
    return { ok: false, latency, error: "DNS_ERROR", message: "DNS resolution failed" };
  }
  if (msg.includes("ECONNREFUSED")) {
    return { ok: false, latency, error: "CONNECTION_REFUSED", message: "Connection refused" };
  }
  if (msg.includes("ECONNRESET") || msg.includes("EPIPE")) {
    return { ok: false, latency, error: "CONNECTION_RESET", message: "Connection reset" };
  }
  if (msg.includes("UNABLE_TO_VERIFY_LEAF_SIGNATURE") || msg.includes("CERT_")) {
    return { ok: false, latency, error: "TLS_ERROR", message: "TLS certificate error" };
  }
  return { ok: false, latency, error: "NETWORK_ERROR", message: msg };
}
