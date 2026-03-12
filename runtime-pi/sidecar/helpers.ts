// Pure functions and constants extracted from server.ts for testability.

// Accepts both simple IDs (gmail) and scoped IDs (@appstrate/gmail)
export const PROVIDER_ID_RE = /^(@[a-z0-9][a-z0-9-]*\/)?[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

export const MAX_RESPONSE_SIZE = 50_000;
export const OUTBOUND_TIMEOUT_MS = 30_000;
export const MAX_SUBSTITUTE_BODY_SIZE = 5 * 1024 * 1024; // 5MB
export const LLM_PROXY_TIMEOUT_MS = 300_000; // 5 minutes

export interface LlmProxyConfig {
  baseUrl: string;
  apiKey: string;
  placeholder: string;
}

// Mirrored in apps/api/src/services/orchestrator/types.ts. Keep in sync.
export interface SidecarConfig {
  platformApiUrl: string;
  executionToken: string;
  proxyUrl: string;
  llm?: LlmProxyConfig;
}

export interface CredentialsResponse {
  credentials: Record<string, string>;
  authorizedUris: string[] | null;
  allowAllUris: boolean;
}

/**
 * Block requests targeting private/internal networks.
 * Shared logic used by both the /proxy endpoint and the forward proxy.
 *
 * Normalizes hostnames through the WHATWG URL parser to defeat bypass techniques:
 * - Numeric IPs: 2130706433, 0x7f000001, 0177.0.0.1 → 127.0.0.1
 * - IPv6 variations: ::ffff:7f00:1, 0:0:0:0:0:ffff:7f00:1 → ::ffff:7f00:1
 * - IPv4-mapped IPv6: ::ffff:169.254.169.254 → ::ffff:a9fe:a9fe
 */
export function isBlockedHost(hostname: string): boolean {
  // Normalize via WHATWG URL parser to canonicalize all representations
  let h: string;
  try {
    const stripped = hostname.replace(/^\[|\]$/g, "");
    const urlStr = stripped.includes(":") ? `http://[${stripped}]/` : `http://${stripped}/`;
    h = new URL(urlStr).hostname.toLowerCase();
    // Bun keeps brackets on IPv6 hostnames — strip them for uniform checks
    h = h.replace(/^\[|\]$/g, "");
  } catch {
    return true; // Unparseable hostname = blocked
  }

  // --- Direct hostname matches ---
  if (h === "localhost" || h === "sidecar" || h === "agent" || h === "host.docker.internal") return true;
  if (h === "metadata.google.internal") return true;

  // --- IPv4 checks (URL parser normalizes all numeric formats to dotted-decimal) ---
  const ipv4Match = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipv4Match) {
    const a = parseInt(ipv4Match[1]!, 10);
    const b = parseInt(ipv4Match[2]!, 10);
    if (a === 0) return true;                             // 0.0.0.0/8
    if (a === 10) return true;                            // 10.0.0.0/8
    if (a === 127) return true;                           // 127.0.0.0/8 (full loopback range)
    if (a === 172 && b >= 16 && b <= 31) return true;     // 172.16.0.0/12
    if (a === 192 && b === 168) return true;              // 192.168.0.0/16
    if (a === 169 && b === 254) return true;              // 169.254.0.0/16 (link-local)
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
  }

  return false;
}

/**
 * Block requests to private/internal networks when no authorizedUris are defined.
 * Prevents SSRF to cloud metadata services, localhost, and internal IPs.
 */
export function isBlockedUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true; // Malformed URL = blocked
  }

  // Block non-HTTPS schemes (except http for known public APIs)
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return true;
  }

  return isBlockedHost(parsed.hostname);
}

export function substituteVars(text: string, credentials: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_match, key) => credentials[key] ?? _match);
}

export function findUnresolvedPlaceholders(text: string): string[] {
  const matches = [...text.matchAll(/\{\{(\w+)\}\}/g)];
  return matches.map((m) => m[1]!);
}

/** RFC 7230 §6.1 hop-by-hop headers — must not be forwarded by proxies. */
export const HOP_BY_HOP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-connection", "transfer-encoding",
  "te", "trailer", "upgrade", "proxy-authorization",
]);

export function matchesAuthorizedUri(url: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern.endsWith("*")) {
      return url.startsWith(pattern.slice(0, -1));
    }
    return url === pattern;
  });
}
