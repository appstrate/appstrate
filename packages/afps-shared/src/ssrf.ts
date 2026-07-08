// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * SSRF protection — blocks requests targeting private/internal networks.
 *
 * Canonical, zero-dependency source of truth. Re-exported verbatim by
 * `@appstrate/core/ssrf` (so every existing platform consumer keeps its
 * import path) and consumed directly by the shared `api-call-engine` in
 * `@appstrate/afps-runtime` — which cannot depend on `@appstrate/core`
 * (it ships standalone with the `afps` CLI). Living in the leaf
 * `@appstrate/afps-shared` package keeps a single implementation reachable
 * from both the platform/sidecar side and the CLI side without a cycle.
 *
 * Normalizes hostnames through the WHATWG URL parser to defeat bypass techniques:
 * - Numeric IPs: 2130706433, 0x7f000001, 0177.0.0.1 → 127.0.0.1
 * - IPv6 variations: ::ffff:7f00:1, 0:0:0:0:0:ffff:7f00:1 → ::ffff:7f00:1
 * - IPv4-mapped IPv6: ::ffff:169.254.169.254 → ::ffff:a9fe:a9fe
 */

/**
 * Check whether a hostname resolves to a private/internal network address.
 * Normalizes through the WHATWG URL parser to defeat bypass techniques
 * (numeric IPs, IPv6 variations, IPv4-mapped IPv6).
 * @param hostname - The hostname or IP address to check
 * @returns true if the host targets a private/internal network and should be blocked
 */
export function isBlockedHost(hostname: string): boolean {
  let h: string;
  try {
    const stripped = hostname.replace(/^\[|\]$/g, "");
    const urlStr = stripped.includes(":") ? `http://[${stripped}]/` : `http://${stripped}/`;
    h = new URL(urlStr).hostname.toLowerCase();
    // Bun keeps brackets on IPv6 hostnames — strip them for uniform checks
    h = h.replace(/^\[|\]$/g, "");
    // A trailing dot is a valid FQDN form that DNS resolves identically
    // (`metadata.google.internal.`, `localhost.`, `127.0.0.1.`) but would
    // slip past the exact-string host matches and the dotted-IP regex
    // below. Normalize it away so the blocklist can't be bypassed.
    h = h.replace(/\.$/, "");
  } catch {
    return true; // Unparseable hostname = blocked
  }

  // --- Direct hostname matches ---
  if (h === "localhost" || h === "sidecar" || h === "agent" || h === "host.docker.internal") {
    return true;
  }
  if (h === "metadata.google.internal") return true;

  // --- IPv4 checks (URL parser normalizes all numeric formats to dotted-decimal) ---
  const ipv4Match = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipv4Match) {
    const a = parseInt(ipv4Match[1]!, 10);
    const b = parseInt(ipv4Match[2]!, 10);
    const c = parseInt(ipv4Match[3]!, 10);
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // 127.0.0.0/8 (full loopback range)
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local)
    // 100.64.0.0/10 — RFC 6598 shared/CGN space. Alibaba & Tencent Cloud expose
    // instance metadata at 100.100.100.200, and K8s/CGN route internal traffic
    // here; without this the whole cloud-metadata SSRF class stays open.
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 (benchmark)
    if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 (IETF protocol assignments)
    if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved + 255.255.255.255
    return false;
  }

  // --- IPv6 checks ---
  if (h.includes(":")) {
    // Loopback (::1) and unspecified (::)
    if (h === "::1" || h === "::") return true;

    // Link-local (fe80::/10 — fe80:: through febf::)
    if (/^fe[89ab][0-9a-f]:/.test(h)) return true;

    // Unique local address (fc00::/7 — fc00:: through fdff::)
    if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;

    // IPv4-mapped IPv6 in hex form (::ffff:HHHH:LLLL)
    // URL parser normalizes ::ffff:127.0.0.1 → ::ffff:7f00:1
    const mappedHex = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex) {
      const high = parseInt(mappedHex[1]!, 16);
      const low = parseInt(mappedHex[2]!, 16);
      const ipv4 = `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
      return isBlockedHost(ipv4);
    }

    // IPv4-mapped IPv6 in dotted notation (::ffff:d.d.d.d) — some parsers preserve this
    const mappedDot = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mappedDot) {
      return isBlockedHost(mappedDot[1]!);
    }

    // IPv4-compatible IPv6 (deprecated but still routed by some stacks): the
    // low 32 bits embed an IPv4 with NO `::ffff:` prefix — ::7f00:1 = 127.0.0.1,
    // ::a9fe:a9fe = 169.254.169.254. Without this branch these slip past the
    // IPv4 blocklist entirely. (`::ffff:H:L` mapped form is matched above and
    // won't collide — it carries three hextets, not two.)
    const compatHex = h.match(/^::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (compatHex) {
      const high = parseInt(compatHex[1]!, 16);
      const low = parseInt(compatHex[2]!, 16);
      const ipv4 = `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
      return isBlockedHost(ipv4);
    }
    const compatDot = h.match(/^::(\d+\.\d+\.\d+\.\d+)$/);
    if (compatDot) {
      return isBlockedHost(compatDot[1]!);
    }
  }

  return false;
}

/**
 * Block requests to private/internal networks. Prevents SSRF to cloud
 * metadata, localhost, etc. `allowHost` (optional) exempts an
 * operator-trusted hostname from the HOST blocklist only — malformed URLs
 * and non-http(s) schemes stay fail-closed regardless, so every
 * allowlist-aware consumer (platform egress sites, sidecar gates) shares
 * this one parse/scheme/blocklist body instead of re-implementing it.
 */
export function isBlockedUrl(url: string, allowHost?: (host: string) => boolean): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true; // Malformed URL = blocked
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return true;
  }

  if (allowHost?.(parsed.hostname)) return false;
  return isBlockedHost(parsed.hostname);
}
