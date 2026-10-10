// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * SSRF protection — blocks requests targeting private/internal networks.
 *
 * Canonical, zero-internal-dependency source of truth. Re-exported verbatim by
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
 * - IPv4 embedded in IPv6 (compatible, mapped, SIIT, NAT64, 6to4) is judged as that IPv4
 */

/** Where a host leads: this machine, an internal network, or the public internet. */
type HostClass = "loopback" | "internal" | "public";

/**
 * Check whether a hostname resolves to a private/internal network address.
 * Normalizes through the WHATWG URL parser to defeat bypass techniques
 * (numeric IPs, IPv6 variations, IPv4-mapped IPv6).
 * @param hostname - The hostname or IP address to check
 * @returns true if the host targets a private/internal network and should be blocked
 */
export function isBlockedHost(hostname: string): boolean {
  return classifyHost(hostname) !== "public";
}

/**
 * Whether `hostname`, in any form {@link isBlockedHost} parses, is this machine; an unparseable
 * hostname counts as loopback (fail closed).
 */
export function isLoopbackHost(hostname: string): boolean {
  return classifyHost(hostname) === "loopback";
}

/** The WHATWG-normalized host: lowercase, unbracketed, no trailing dot; null when unparseable. */
function normalizeHost(hostname: string): string | null {
  try {
    const stripped = hostname.replace(/^\[|\]$/g, "");
    const urlStr = stripped.includes(":") ? `http://[${stripped}]/` : `http://${stripped}/`;
    // Bun keeps brackets on IPv6 hostnames — strip them for uniform checks
    const h = new URL(urlStr).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    // A trailing dot is a valid FQDN form that DNS resolves identically
    // (`metadata.google.internal.`, `localhost.`, `127.0.0.1.`) but would
    // slip past the exact-string host matches and the dotted-IP regex
    // below. Normalize it away so the blocklist can't be bypassed.
    return h.replace(/\.$/, "");
  } catch {
    return null;
  }
}

function classifyHost(hostname: string): HostClass {
  const h = normalizeHost(hostname);
  if (h === null) return "loopback"; // Unparseable hostname = blocked, and loopback

  // --- Direct hostname matches ---
  // Every `*.localhost` name is loopback (RFC 6761 §6.3).
  if (h === "localhost" || h.endsWith(".localhost")) return "loopback";
  if (h === "sidecar" || h === "agent" || h === "host.docker.internal") return "internal";
  if (h === "metadata.google.internal") return "internal";

  // --- IPv4 checks (URL parser normalizes all numeric formats to dotted-decimal) ---
  const ipv4Match = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipv4Match) {
    const a = parseInt(ipv4Match[1]!, 10);
    const b = parseInt(ipv4Match[2]!, 10);
    const c = parseInt(ipv4Match[3]!, 10);
    if (a === 0 || a === 127) return "loopback"; // 0.0.0.0/8, 127.0.0.0/8 (full loopback range)
    if (a === 10) return "internal"; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return "internal"; // 172.16.0.0/12
    if (a === 192 && b === 168) return "internal"; // 192.168.0.0/16
    if (a === 169 && b === 254) return "internal"; // 169.254.0.0/16 (link-local)
    // 100.64.0.0/10 — RFC 6598 shared/CGN space. Alibaba & Tencent Cloud expose
    // instance metadata at 100.100.100.200, and K8s/CGN route internal traffic
    // here; without this the whole cloud-metadata SSRF class stays open.
    if (a === 100 && b >= 64 && b <= 127) return "internal";
    if (a === 198 && (b === 18 || b === 19)) return "internal"; // 198.18.0.0/15 (benchmark)
    // 192.0.0.0/24 (IETF protocol assignments)
    if (a === 192 && b === 0 && c === 0) return "internal";
    // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved + 255.255.255.255
    if (a >= 224) return "internal";
    return "public";
  }

  // --- IPv6 checks ---
  if (h.includes(":")) {
    // Loopback (::1) and unspecified (::)
    if (h === "::1" || h === "::") return "loopback";

    // Link-local (fe80::/10 — fe80:: through febf::)
    if (/^fe[89ab][0-9a-f]:/.test(h)) return "internal";

    // Deprecated site-local (fec0::/10 — fec0:: through feff::)
    if (/^fe[c-f][0-9a-f]:/.test(h)) return "internal";

    // Multicast (ff00::/8)
    if (/^ff[0-9a-f]{2}:/.test(h)) return "internal";

    // Unique local address (fc00::/7 — fc00:: through fdff::)
    if (/^f[cd][0-9a-f]{2}:/.test(h)) return "internal";

    const groups = ipv6Groups(h);
    if (!groups) return "loopback"; // unparseable, as above
    // 64:ff9b:1::/48 — RFC 8215 local-use translation prefix, not globally
    // reachable, and its operator picks the embedding length: blocked whole, like ULA.
    if (groups[0] === 0x64 && groups[1] === 0xff9b && groups[2] === 1) return "internal";

    // An IPv6 address that carries an IPv4 one reaches that IPv4 host: judge it as such.
    const ipv4 = embeddedIpv4(groups);
    if (ipv4) return classifyHost(ipv4);
  }

  return "public";
}

/** The eight 16-bit groups of a WHATWG-serialized (hex, `::`-compressed) IPv6 address, or null. */
function ipv6Groups(h: string): number[] | null {
  const halves = h.split("::");
  if (halves.length > 2) return null;
  const hex = (part: string | undefined) => (part ? part.split(":") : []);
  const head = hex(halves[0]);
  const tail = hex(halves[1]);
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const parts = [...head, ...new Array<string>(Math.max(fill, 0)).fill("0"), ...tail];
  if (parts.length !== 8 || !parts.every((p) => /^[0-9a-f]{1,4}$/.test(p))) return null;
  return parts.map((p) => parseInt(p, 16));
}

/**
 * The IPv4 address embedded under a prefix that routes to it: IPv4-compatible `::/96`,
 * IPv4-mapped `::ffff:0:0/96`, SIIT IPv4-translated `::ffff:0:0:0/96` (RFC 2765),
 * NAT64 `64:ff9b::/96` (RFC 6052), 6to4 `2002::/16` (RFC 3056).
 */
function embeddedIpv4(g: number[]): string | null {
  const quad = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (zero(0, 5) && (g[5] === 0 || g[5] === 0xffff)) return quad(g[6]!, g[7]!);
  if (zero(0, 4) && g[4] === 0xffff && g[5] === 0) return quad(g[6]!, g[7]!);
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return quad(g[6]!, g[7]!);
  if (g[0] === 0x2002) return quad(g[1]!, g[2]!);
  return null;
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

/** The parsed `EGRESS_ALLOW_INTERNAL_HOSTS` list: the accepted hosts and one reason per refused entry. */
export interface EgressAllowlistParse {
  /** Lowercased bare hostnames / dotted IPv4, matched exactly against a URL's `hostname`. */
  hosts: ReadonlySet<string>;
  /** One `"<entry>" <reason>` per refused entry, in input order; empty when valid. */
  invalid: readonly string[];
}

/**
 * Parse the comma-separated `EGRESS_ALLOW_INTERNAL_HOSTS` list. Empty items are skipped; every other
 * entry is either kept as a host or refused with a reason. IPv6 literals are refused: the per-run
 * bridge is IPv4-only, and sidecar CONNECT hosts arrive unbracketed while `URL.hostname` keeps brackets.
 */
export function parseEgressAllowInternalHosts(raw: string | undefined): EgressAllowlistParse {
  const hosts = new Set<string>();
  const invalid: string[] = [];
  for (const item of (raw ?? "").split(",")) {
    const entry = item.trim().toLowerCase();
    if (entry === "") continue;
    const reason = egressEntryRefusal(entry);
    if (reason === null) hosts.add(entry);
    else invalid.push(`"${entry}" ${reason}`);
  }
  return { hosts, invalid };
}

/** The reason a non-empty, trimmed, lowercased entry is refused, or null when it is a valid host. */
function egressEntryRefusal(entry: string): string | null {
  if (/\s/.test(entry)) return "contains whitespace — separate entries with commas";
  if (entry.includes("://")) return "is a URL — list the bare hostname";
  if (entry.includes("/")) return `contains "/" — list the bare hostname, without a path`;
  if (entry.includes("*")) return `contains "*" — wildcards are not supported; list each host`;
  if (entry.includes("@")) return `contains "@" — list the bare hostname`;
  if (/[:[\]]/.test(entry)) {
    return `contains ":" — a port is not part of an entry, and IPv6 literals are not supported (give the host a DNS name)`;
  }
  if (entry.endsWith(".")) return `ends with "." — drop the trailing dot`;

  let parsed: URL | null;
  try {
    parsed = new URL(`http://${entry}/`);
  } catch {
    parsed = null;
  }
  if (!/^[a-z0-9._-]+$/.test(entry)) {
    // Only a host that the URL parser keeps whole (nothing spills into a query or path) has a canonical form.
    const canonical = parsed && parsed.href === `http://${parsed.hostname}/` ? parsed.hostname : "";
    return /^[a-z0-9._-]+$/.test(canonical)
      ? `is not in canonical form — write it as "${canonical}"`
      : "contains characters a hostname cannot hold";
  }
  if (!parsed) return "is not a valid hostname or IPv4 address";
  if (parsed.hostname !== entry)
    return `is not in canonical form — write it as "${parsed.hostname}"`;
  return null;
}
