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
 * Scrub credential material from a free-form text sample before it lands in an
 * operator log or a run failure report. Upstream payloads don't normally echo
 * credentials, but the no-leak guarantee must hold independent of upstream
 * behavior.
 *
 * THE single scrubber for the sidecar. There were two: this one covered only
 * `sk-ant-…` and `Bearer …`, while `integrations-boot.scrubStderrLine` covered
 * a strict superset — and the two lived in the same process with no trust
 * boundary between them, so the weaker one simply leaked more. A `ghp_…`, a
 * JWT or an `AKIA…` in an upstream error body survived into the operator log
 * on the `/llm` path and was masked on the runner-stderr path. The superset
 * won; callers that also need a length cap apply it themselves.
 *
 * Separator-prefixed families (`sk-…`, `ghp_…`, `xoxb-…`) keep the mandatory
 * `-`/`_` so prose words starting with `sk`/`pk` survive; AWS access-key ids
 * (`AKIA` + upper-alnum, no separator) and Google OAuth tokens (`ya29.` + dot)
 * get their own literal shapes. `sk-ant-` is matched case-insensitively ahead
 * of the generic family rule because Anthropic keys appear upper-cased in some
 * upstream error text, and the generic rule is deliberately case-sensitive.
 *
 * NOTE two deliberate deviations from the obvious regexes.
 *
 * First, `\b` is absent on the `Bearer|Basic` and `sk-ant-` rules. Those two
 * literals are specific enough to need no word anchor, and an anchor there is
 * actively harmful: in percent-encoded text the `0` of `%20` sits immediately
 * before `B`, so `\b` never matches. `\b` is kept ONLY on the generic
 * `sk|pk|ghp|…` family rule, which is where it earns its place (it is what
 * keeps "skeletons" and "pkgroots" readable).
 *
 * Second, the separator groups accept percent-encoded forms (`%20` for space,
 * `%3A`/`%3D`/`%22`/`%27` for `:`/`=`/`"`/`'`). Dropping `\b` alone was NOT
 * enough and the earlier comment here wrongly claimed otherwise: `%20` is not
 * `\s`, so `(Bearer|Basic)\s+` could not match `Bearer%20<token>` with or
 * without the anchor. That shape — an upstream error body or a redirect target
 * echoing `?h=Authorization%3A%20Bearer%20…` — is exactly what these rules
 * exist for, and only `sk-ant-` keys were being caught in it; an opaque
 * Vertex/Azure/generic OAuth bearer shipped verbatim to the operator log.
 * Each separator alternative starts with a distinct character (`%` is in none
 * of the literal classes), so the groups stay unambiguous and linear-time.
 */
export function scrubSecretMaterial(text: string): string {
  return text
    .replace(/(Bearer|Basic)(?:\s|%20)+[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]")
    .replace(/\beyJ[A-Za-z0-9._-]{10,}/g, "[redacted-jwt]")
    .replace(/sk-ant-[A-Za-z0-9._-]+/gi, "[redacted-key]")
    .replace(/\b(sk|pk|ghp|gho|ghs|xox[baprs])[-_][A-Za-z0-9._-]{6,}/g, "[redacted-key]")
    .replace(/\bAKIA[A-Z0-9]{12,}/g, "[redacted-key]")
    .replace(/\bya29\.[A-Za-z0-9._-]{6,}/g, "[redacted-key]")
    .replace(
      /\b(token|secret|password|api[_-]?key|authorization|access[_-]?token|refresh[_-]?token)((?:["'\s:=]|%20|%3A|%3D|%22|%27)+)[^\s"',&]+/gi,
      "$1$2[redacted]",
    );
}
