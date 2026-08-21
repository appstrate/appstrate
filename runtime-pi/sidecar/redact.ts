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
 */

/**
 * Start-of-credential anchor, replacing a bare `\b`.
 *
 * This exists because `\b` was wrong here THREE times, each caught only after
 * the previous "fix" shipped, so the rule is now stated once instead of spelled
 * out per pattern. Percent-encoded text is the whole problem: every triplet
 * ends in an alphanumeric (`%20`→`0`, `%3D`→`D`, `%26`→`6`), and every shape
 * below starts with one, so `\b` — which needs a non-word character on the
 * left — can never match a credential that follows an encoded separator. That
 * is not an exotic input: it is what a redirect target or an echoed
 * `redirect_uri` looks like in an upstream error body, i.e. the exact material
 * this function exists to scrub.
 *
 * `(?<=^|[^A-Za-z0-9_])` is EXACTLY equivalent to `\b` for these patterns
 * (they all begin with a word character, so `\b` reduces to "start, or a
 * non-word char on the left"). The `%[0-9A-Fa-f]{2}` alternative is the only
 * widening: it additionally admits a preceding percent-triplet. So the prose
 * protection `\b` bought is preserved intact — "risk-averse" still does not
 * match the `sk-…` family, "skeletons" and "pkgroots" stay readable — while
 * the encoded case is no longer a hole.
 */
const CRED_START = String.raw`(?<=^|%[0-9A-Fa-f]{2}|[^A-Za-z0-9_])`;

/**
 * Ordered scrub rules. Compiled once: these run on every proxied error body.
 *
 * `Bearer|Basic` and `sk-ant-` deliberately carry NO anchor — those literals
 * are specific enough not to need one. Their separator group accepts `%20`
 * alongside real whitespace for the same reason `CRED_START` exists, and the
 * token class admits `%` so a percent-encoded base64 credential is masked
 * whole rather than up to its first `%2B`.
 *
 * Every alternative in every separator group starts with a distinct character
 * (`%` appears in none of the literal classes), so the groups stay unambiguous
 * and the whole set runs in linear time.
 */
const SCRUB_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/(Bearer|Basic)(?:\s|%20)+[A-Za-z0-9._~+/=%-]+/gi, "$1 [redacted]"],
  [new RegExp(`${CRED_START}eyJ[A-Za-z0-9._-]{10,}`, "g"), "[redacted-jwt]"],
  [/sk-ant-[A-Za-z0-9._-]+/gi, "[redacted-key]"],
  [
    new RegExp(`${CRED_START}(?:sk|pk|ghp|gho|ghs|xox[baprs])[-_][A-Za-z0-9._-]{6,}`, "g"),
    "[redacted-key]",
  ],
  [new RegExp(`${CRED_START}AKIA[A-Z0-9]{12,}`, "g"), "[redacted-key]"],
  [new RegExp(`${CRED_START}ya29\\.[A-Za-z0-9._-]{6,}`, "g"), "[redacted-key]"],
  [
    new RegExp(
      `${CRED_START}(token|secret|password|api[_-]?key|authorization|access[_-]?token|refresh[_-]?token)` +
        `((?:["'\\s:=]|%20|%3A|%3D|%22|%27)+)[^\\s"',&]+`,
      "gi",
    ),
    "$1$2[redacted]",
  ],
];

export function scrubSecretMaterial(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SCRUB_RULES) out = out.replace(pattern, replacement);
  return out;
}
