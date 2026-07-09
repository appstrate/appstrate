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
 *
 * `Location` is special-cased: dropping it entirely would blind the
 * operator on redirect-loop diagnosis, but logging it verbatim leaks a
 * presigned/`?access_token=` redirect target into the debug envelope.
 * It is redacted to origin + path (query string, fragment, and userinfo
 * stripped) — same philosophy as `redactHost` in the api-call engine.
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
 * Redact a `Location` header value to origin + path.
 *
 * Redirect targets routinely carry capabilities in the query string
 * (S3 presigned `X-Amz-Signature`, OAuth `?access_token=`/`?code=`) and
 * occasionally userinfo in the authority — none of which may reach the
 * operator log. The origin + path is kept because it is the part an
 * operator needs to diagnose a redirect loop.
 *
 * Handles the three RFC 7231 §7.1.2 reference forms:
 *   - absolute (`https://host/p?q`) → `https://host/p` (userinfo is not
 *     part of `URL.origin`, so it is stripped for free),
 *   - scheme-relative (`//host/p?q`) → `//host/p` (parsed against a dummy
 *     base so userinfo is stripped rather than string-sliced),
 *   - relative (`/p?q`, `p?q`) → kept as-is minus query/fragment.
 */
export function redactLocationHeader(value: string): string {
  try {
    const u = new URL(value);
    return `${u.origin}${u.pathname}`;
  } catch {
    // Not an absolute URL — fall through to the relative forms.
  }
  if (value.startsWith("//")) {
    try {
      const u = new URL(value, "https://placeholder.invalid");
      return `//${u.host}${u.pathname}`;
    } catch {
      return "<unparseable>";
    }
  }
  const cut = value.search(/[?#]/);
  return cut === -1 ? value : value.slice(0, cut);
}

/** Drop a sensitive header (`null`), redact `Location`, or pass through. */
function redactHeaderValue(key: string, value: string): string | null {
  const lower = key.toLowerCase();
  if (SENSITIVE_HEADER_NAMES.has(lower)) return null;
  if (lower === "location") return redactLocationHeader(value);
  return value;
}

/**
 * Drop sensitive headers (and redact `Location` to origin + path) and
 * return a plain object suitable for JSON serialization in the operator
 * log. Original casing is preserved on the surviving entries.
 */
export function filterSensitiveHeaders(
  headers: Headers | Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      const kept = redactHeaderValue(key, value);
      if (kept !== null) out[key] = kept;
    });
    return out;
  }
  for (const [key, value] of Object.entries(headers)) {
    const kept = redactHeaderValue(key, value);
    if (kept !== null) out[key] = kept;
  }
  return out;
}

/**
 * Scrub bearer/api-key material from a free-form text sample before it lands
 * in an operator log. Upstream JSON error payloads don't normally echo
 * credentials, but the no-leak guarantee must hold independent of upstream
 * behavior — so any `sk-ant-…` token or `Bearer …` sequence is masked.
 */
export function scrubBearerMaterial(text: string): string {
  return text.replace(/(sk-ant-[a-z0-9-]+|Bearer\s+[\w.~+/=-]+)/gi, "[redacted]");
}
