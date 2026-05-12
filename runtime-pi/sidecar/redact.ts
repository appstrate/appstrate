// SPDX-License-Identifier: Apache-2.0

/**
 * Operator-log redaction helpers for the OAuth LLM proxy path.
 *
 * Upstream LLM providers routinely echo sensitive material on
 * auth-failure responses: a fresh access token
 * surfaced via `WWW-Authenticate`, a session cookie set on a 401, a JWT
 * embedded in a JSON error body, and so on. The sidecar's warn log is
 * collected by the operator's log aggregator (pino JSON → stdout), so any
 * verbatim copy is a credential leak in cleartext.
 *
 * Two surfaces to scrub:
 *   - response headers — drop the well-known credential carriers
 *     entirely (`set-cookie`, `www-authenticate`, …) rather than try to
 *     parse their values.
 *   - response body samples — regex-replace known token shapes (JWTs,
 *     `sk-…`, `sk-ant-…`, `Bearer …`) with explicit redaction markers.
 *
 * Both helpers are pure and synchronous — the goal is to keep them
 * trivial to unit-test in isolation from the proxy.
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

/**
 * Regex-based redaction of known secret shapes in arbitrary text. Order
 * matters — the longer / more specific shapes run first so the broader
 * `sk-` rule never clobbers a `sk-ant-` token mid-replace.
 *
 * Shapes handled:
 *   - JWT (`eyJ…\.eyJ…\.…`) → `***JWT-REDACTED***`
 *   - `Bearer <token>` (HTTP auth)         → `Bearer ***REDACTED***`
 *   - Anthropic API keys (`sk-ant-…`)      → `sk-ant-***REDACTED***`
 *   - Generic `sk-` keys ≥20 body chars    → `sk-***REDACTED***`
 *     (the 20-char floor preserves obvious dev placeholders such as
 *     `sk-placeholder`, `sk-test`, `sk-foo` that we want to keep
 *     readable in operator logs.)
 */
export function redactSecrets(text: string): string {
  if (!text) return text;

  // JWT: three dot-separated base64url segments, the first two starting
  // with `eyJ` (which decodes to `{"`). The third segment is the
  // signature — we require ≥1 char to avoid matching `header.payload.`
  // placeholders that some docs/examples use.
  let out = text.replace(
    /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    "***JWT-REDACTED***",
  );

  // `Bearer <token>` — HTTP auth scheme. Token charset per RFC 6750
  // (base64url + `=` padding + `+/`).
  out = out.replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/g, "Bearer ***REDACTED***");

  // Anthropic-prefixed keys first, so the generic `sk-` rule below never
  // partially overwrites the `ant-` segment.
  out = out.replace(/sk-ant-[\w-]+/g, "sk-ant-***REDACTED***");

  // Generic `sk-` keys: require ≥20 chars after the prefix to skip
  // obvious placeholders like `sk-placeholder` (14) or `sk-test` (7).
  // Real OpenAI keys are ~48 chars; 20 is a safe floor that keeps short
  // dev sentinels readable while catching the real thing.
  out = out.replace(/sk-[\w-]{20,}/g, "sk-***REDACTED***");

  return out;
}
