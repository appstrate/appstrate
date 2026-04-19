// SPDX-License-Identifier: Apache-2.0

/**
 * Map a fetch-time error (DNS / TCP / TLS / timeout) to a curl-
 * compatible process exit code, so `appstrate api` feels the same as
 * `curl` to shell scripts and coding agents that already key off those
 * codes.
 *
 * Reference: libcurl-errors(3) — https://curl.se/libcurl/c/libcurl-errors.html
 *
 *   6  CURLE_COULDNT_RESOLVE_HOST   DNS failed (ENOTFOUND / EAI_AGAIN)
 *   7  CURLE_COULDNT_CONNECT        TCP refused / unreachable
 *  28  CURLE_OPERATION_TIMEDOUT     --max-time exceeded (AbortError w/ timeout cause)
 *  35  CURLE_SSL_CONNECT_ERROR      TLS handshake failed
 *
 * Anything we cannot classify falls back to 1 (generic failure) — we
 * deliberately do NOT emit a curl-specific code we are not sure about,
 * because users parse these.
 */

export const EXIT_DNS = 6;
export const EXIT_CONNECT = 7;
export const EXIT_TIMEOUT = 28;
export const EXIT_TLS = 35;

/**
 * Best-effort classifier. Walks the error chain (`cause`) because Bun's
 * fetch frequently wraps the low-level syscall error inside a generic
 * `TypeError: fetch failed`.
 */
export function classifyNetworkError(err: unknown): number {
  if (!err || typeof err !== "object") return 1;

  // Timeout branch: we ourselves raise `AbortError` via
  // `ac.abort(new DOMException("timeout", "TimeoutError"))` when
  // `--max-time` fires. The DOMException subclass flows through as the
  // `.name` on the rejection.
  const name = (err as { name?: unknown }).name;
  if (name === "TimeoutError") return EXIT_TIMEOUT;

  // Walk the cause chain (up to 3 levels — defensive against cycles).
  let current: unknown = err;
  for (let i = 0; i < 3 && current && typeof current === "object"; i++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") {
      // Bun surfaces these as upper-case strings on the underlying
      // `SystemError`-like object.
      if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "EAI_FAIL") return EXIT_DNS;
      if (
        code === "ECONNREFUSED" ||
        code === "EHOSTUNREACH" ||
        code === "ENETUNREACH" ||
        code === "ECONNRESET"
      ) {
        return EXIT_CONNECT;
      }
      if (
        code.startsWith("ERR_TLS_") ||
        code === "CERT_HAS_EXPIRED" ||
        code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
        code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
        code === "SELF_SIGNED_CERT_IN_CHAIN" ||
        code === "ERR_SSL_PROTOCOL_ERROR"
      ) {
        return EXIT_TLS;
      }
    }
    current = (current as { cause?: unknown }).cause;
  }

  // Textual fallback — Bun sometimes emits TLS errors without a code.
  const msg = (err as { message?: unknown }).message;
  if (typeof msg === "string") {
    const lower = msg.toLowerCase();
    if (lower.includes("unable to verify") || lower.includes("self-signed")) return EXIT_TLS;
    if (lower.includes("getaddrinfo") || lower.includes("dns")) return EXIT_DNS;
    if (lower.includes("connection refused")) return EXIT_CONNECT;
  }

  return 1;
}

/**
 * Human-readable label for the exit code, used for the single stderr
 * line we print before exiting. Kept short — we do not try to reproduce
 * curl's exact messages, just give the user enough to disambiguate.
 */
export function labelForExitCode(code: number): string {
  switch (code) {
    case EXIT_DNS:
      return "Could not resolve host";
    case EXIT_CONNECT:
      return "Could not connect";
    case EXIT_TIMEOUT:
      return "Operation timed out";
    case EXIT_TLS:
      return "SSL/TLS handshake failed";
    default:
      return "Network error";
  }
}
