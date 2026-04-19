// SPDX-License-Identifier: Apache-2.0

/**
 * Instance URL normalization + HTTPS enforcement.
 *
 * The CLI ships a bearer session token on every authenticated request.
 * Over plaintext `http://` against a non-loopback host, that token is
 * readable by any network intermediary (corporate egress proxy, captive
 * portal, compromised Wi-Fi AP) — replay is immediate account takeover.
 *
 * Default policy: refuse. Loopback (localhost / 127.0.0.1 / ::1) is
 * always allowed because the packet never leaves the host. Explicit
 * opt-in via `APPSTRATE_INSECURE=1` (settable by `appstrate --insecure`)
 * covers lab setups that terminate TLS at a reverse proxy on a trusted
 * LAN segment.
 *
 * Enforcement runs in two places:
 *   - `apiFetchRaw` (every authenticated request, defense in depth
 *     against a hand-edited `config.toml`).
 *   - `login` command (before the initial `/device/code` call, so the
 *     user sees the rejection before typing their credentials).
 *   - `device-flow.ts` helpers (before the device-code and polling
 *     requests — no bearer token yet, but `/device/token` response
 *     carries the freshly-minted session we must not leak).
 */

// Static names we always treat as loopback. IPv6 literals round-trip
// through WHATWG `URL.hostname` with brackets preserved
// (`new URL("http://[::1]").hostname === "[::1]"`). Non-loopback IPv4
// forms like `127.0.0.2` are **not** here by design: whitelisting the
// whole 127/8 would require reasoning about the CLI's actual use case
// (the official install always uses `localhost`/`127.0.0.1`), and a
// smaller surface is easier to defend.
const LOOPBACK_STATIC_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export class InsecureInstanceError extends Error {
  constructor(public readonly url: string) {
    super(
      `Refusing to send credentials to a non-HTTPS, non-loopback instance: ${url}\n` +
        `  - Use https:// (recommended), or\n` +
        `  - Pass --insecure / set APPSTRATE_INSECURE=1 to acknowledge the risk.`,
    );
    this.name = "InsecureInstanceError";
  }
}

/** Strip exactly one trailing `/`. Mirrors the previous duplicated `normalizeBase`. */
export function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

export function isInsecureOptIn(): boolean {
  const v = process.env.APPSTRATE_INSECURE;
  return v === "1" || v === "true";
}

/**
 * Validate + normalize an instance URL. Throws `InsecureInstanceError`
 * for `http://<non-loopback>` without the insecure opt-in. Also rejects
 * non-http(s) schemes to avoid surprises from `file://`, `ws://`, etc.
 *
 * Returns the trimmed URL with any trailing slash stripped. The URL is
 * returned as-is (no case folding, no default port injection) so the
 * string the user stored is the string that ends up in request logs.
 */
export function normalizeInstance(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) {
    throw new Error("Instance URL is empty.");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid instance URL: "${trimmed}"`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `Unsupported instance URL protocol: ${parsed.protocol} (expected http:// or https://).`,
    );
  }
  if (parsed.protocol === "http:" && !isLoopback(parsed.hostname) && !isInsecureOptIn()) {
    throw new InsecureInstanceError(trimmed);
  }
  return stripTrailingSlash(trimmed);
}

export function isLoopback(hostname: string): boolean {
  if (LOOPBACK_STATIC_HOSTS.has(hostname)) return true;
  // IPv6 literals arrive from `URL.hostname` wrapped in `[…]`. The parser
  // also *canonicalizes* them: `[::ffff:127.0.0.1]` becomes
  // `[::ffff:7f00:1]` (hex-compressed IPv4-mapped IPv6), and
  // `[0:0:0:0:0:0:0:1]` becomes `[::1]` (collapsed via ::). So we strip
  // the brackets and interpret the address by structure rather than
  // maintaining a brittle enum of string forms.
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    const inner = hostname.slice(1, -1);
    return isLoopbackIPv6(inner);
  }
  return false;
}

/**
 * Is `addr` a loopback IPv6 address in any canonical form the WHATWG
 * URL parser might emit?
 *
 *   - `::1` (loopback)
 *   - `::ffff:127.0.0.1` / `::ffff:7f00:1` (IPv4-mapped IPv6 of
 *     127.0.0.1 — the parser hex-compresses the 127.0.0.1 portion into
 *     `7f00:1`)
 *
 * We do NOT accept IPv4-mapped loopback for addresses beyond 127.0.0.1;
 * the CLI's instance URL policy caps IPv4 loopback at 127.0.0.1
 * regardless of wrapping.
 */
function isLoopbackIPv6(addr: string): boolean {
  if (addr === "::1") return true;
  const lower = addr.toLowerCase();
  // IPv4-mapped IPv6: `::ffff:a.b.c.d` OR `::ffff:X:Y` where the last
  // 32 bits spell 127.0.0.1. The parser emits the compressed hex form
  // (`::ffff:7f00:1`) on most inputs; we also accept the dotted form
  // for future-proofing.
  if (lower === "::ffff:127.0.0.1" || lower === "::ffff:7f00:1") return true;
  return false;
}

/**
 * Validate a URL returned by the server (notably `verification_uri` and
 * `verification_uri_complete` from `/device/code`) before handing it to
 * `open()` / `xdg-open` / `start`. RFC 8628 §5.3 assumes the user notices
 * a wrong URL in the browser address bar — that's too weak a defense
 * once `xdg-open` on Linux can dispatch `file://`, `javascript:`, or
 * custom schemes to registered `.desktop` handlers (MITRE T1547.013).
 *
 * Two checks:
 *   1. Scheme must be `http(s)` — blocks file/javascript/custom-scheme
 *      redirects that `xdg-open` would happily hand to a handler.
 *   2. Host must match the expected instance host — prevents a
 *      compromised or misbehaving server from redirecting approval to
 *      an attacker-controlled phishing page.
 *
 * HTTP scheme is tolerated only when the target is loopback, mirroring
 * the policy in `normalizeInstance`. Otherwise a devserver quirk where
 * the `/device/code` response points at `http://localhost:3000/activate`
 * from an `http://localhost:3000` instance would be rejected.
 */
export function assertSafeVerificationUrl(uri: string, instance: string): URL {
  const instanceUrl = new URL(instance);
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error(`Refusing unparseable verification URL: "${uri}"`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Refusing non-http(s) verification URL: ${parsed.protocol} (got "${uri}")`);
  }
  // Origin match: hostname (case + trailing-dot normalized) AND port
  // must agree. Host-only comparison was bypassable two ways:
  //   - `app.example.com.` vs `app.example.com` — WHATWG preserves a
  //     trailing dot on the parsed hostname, and DNS resolves both but
  //     they are *different strings*. A compromised server returning
  //     the dotted form would fail the naive check AND, in the inverse
  //     scenario, a redirector on the dotted form would pass.
  //   - `:8443` vs `:443` — `.hostname` ignores port entirely, so a
  //     server could redirect to an alternate port on the same host.
  //     Same-origin is `scheme + host + port` per RFC 6454; we compare
  //     host + port explicitly (scheme is separately constrained to
  //     http/https above).
  const parsedHost = normalizeHostForComparison(parsed.hostname);
  const instanceHost = normalizeHostForComparison(instanceUrl.hostname);
  if (parsedHost !== instanceHost) {
    throw new Error(
      `Refusing verification URL with host "${parsed.hostname}" — ` +
        `expected "${instanceUrl.hostname}" to match the instance.`,
    );
  }
  // `URL.port` is "" when the port equals the scheme default. Normalize
  // to the effective port before comparing so `http://app:80` matches
  // `http://app`.
  const parsedPort = effectivePort(parsed);
  const instancePort = effectivePort(instanceUrl);
  if (parsedPort !== instancePort) {
    throw new Error(
      `Refusing verification URL on port ${parsedPort} — ` + `instance is on port ${instancePort}.`,
    );
  }
  if (parsed.protocol === "http:" && !isLoopback(parsed.hostname) && !isInsecureOptIn()) {
    throw new Error(
      `Refusing http:// verification URL on a non-loopback host: "${uri}". ` +
        `Pass --insecure / set APPSTRATE_INSECURE=1 to acknowledge the risk.`,
    );
  }
  return parsed;
}

/**
 * Normalize a hostname for exact-match comparison. `URL.hostname` is
 * already lowercase-folded by WHATWG, but it preserves a trailing dot
 * (`"app.example.com."`). Strip one trailing dot — DNS treats a single
 * trailing dot as the unambiguous FQDN form of the same name, and we
 * don't want a legitimate server returning either form to trip the
 * origin check.
 */
function normalizeHostForComparison(hostname: string): string {
  return hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
}

function effectivePort(url: URL): string {
  if (url.port !== "") return url.port;
  if (url.protocol === "http:") return "80";
  if (url.protocol === "https:") return "443";
  // Unknown scheme — the scheme check above already rejected these, but
  // return an opaque placeholder rather than "" so two such URLs don't
  // silently compare equal.
  return `unknown:${url.protocol}`;
}
