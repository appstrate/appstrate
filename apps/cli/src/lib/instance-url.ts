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

// `URL.hostname` returns IPv6 literals with brackets in Bun/WHATWG
// (`new URL("http://[::1]").hostname === "[::1]"`), but we also accept
// the bare form so consumers that normalize upstream don't get punished.
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

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

function isLoopback(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname);
}
