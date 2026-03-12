/**
 * SSRF protection — blocks requests targeting private/internal networks.
 * Extracted from runtime-pi/sidecar/helpers.ts for use in the API layer.
 */

/**
 * Block requests targeting private/internal networks.
 * Normalizes hostnames through the WHATWG URL parser to defeat bypass techniques.
 */
export function isBlockedHost(hostname: string): boolean {
  let h: string;
  try {
    const stripped = hostname.replace(/^\[|\]$/g, "");
    const urlStr = stripped.includes(":") ? `http://[${stripped}]/` : `http://${stripped}/`;
    h = new URL(urlStr).hostname.toLowerCase();
    h = h.replace(/^\[|\]$/g, "");
  } catch {
    return true;
  }

  if (h === "localhost" || h === "sidecar" || h === "agent" || h === "host.docker.internal")
    return true;
  if (h === "metadata.google.internal") return true;

  const ipv4Match = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipv4Match) {
    const a = parseInt(ipv4Match[1]!, 10);
    const b = parseInt(ipv4Match[2]!, 10);
    if (a === 0) return true;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }

  if (h.includes(":")) {
    if (h === "::1" || h === "::") return true;
    if (/^fe[89ab][0-9a-f]:/.test(h)) return true;
    if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;

    const mappedHex = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex) {
      const high = parseInt(mappedHex[1]!, 16);
      const low = parseInt(mappedHex[2]!, 16);
      const ipv4 = `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
      return isBlockedHost(ipv4);
    }

    const mappedDot = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mappedDot) {
      return isBlockedHost(mappedDot[1]!);
    }
  }

  return false;
}

/**
 * Block requests to private/internal networks.
 * Prevents SSRF to cloud metadata services, localhost, and internal IPs.
 */
export function isBlockedUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return true;
  }

  return isBlockedHost(parsed.hostname);
}
