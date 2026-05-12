// SPDX-License-Identifier: Apache-2.0

/**
 * Operator-log header redaction for the OAuth LLM proxy path.
 *
 * Upstream LLM providers can echo credential-bearing material on
 * auth-failure responses (`WWW-Authenticate` challenge, `Set-Cookie`
 * session token). The sidecar's warn log is collected by the operator's
 * log aggregator (pino JSON → stdout), so any verbatim copy is a leak.
 *
 * We drop the well-known credential-carrying headers entirely rather
 * than try to parse their values. Body samples are truncated to a small
 * preview (set at the call-site) — JSON error payloads from major LLM
 * providers don't echo bearer tokens back, so per-shape regex scrubbing
 * is unnecessary.
 */

/**
 * Headers stripped from operator logs. Lowercased for case-insensitive
 * comparison; HTTP header names are case-insensitive per RFC 7230.
 *
 * Rationale per entry:
 *   - `set-cookie`            session cookies set by the upstream
 *   - `www-authenticate`      can carry a fresh bearer challenge
 *   - `proxy-authenticate`    same as above for proxy hops
 *   - `authorization`         echoed back on some 401 paths
 *   - `x-api-key`             ditto for api-key auth schemes
 *   - `cookie`                inbound cookies if the upstream mirrors them
 */
const SENSITIVE_HEADER_NAMES = new Set<string>([
  "set-cookie",
  "www-authenticate",
  "proxy-authenticate",
  "authorization",
  "x-api-key",
  "cookie",
]);

/**
 * Drop sensitive headers and return a plain object suitable for JSON
 * serialization in the operator log. Original casing is preserved on the
 * surviving entries.
 */
export function filterSensitiveHeaders(
  headers: Headers | Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      if (!SENSITIVE_HEADER_NAMES.has(key.toLowerCase())) {
        out[key] = value;
      }
    });
    return out;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (!SENSITIVE_HEADER_NAMES.has(key.toLowerCase())) {
      out[key] = value;
    }
  }
  return out;
}
