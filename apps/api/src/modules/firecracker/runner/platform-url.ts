// SPDX-License-Identifier: Apache-2.0

/**
 * Single validator/parser for the guest-visible platform API URL, shared by
 * the daemon's env schema (./env.ts) and the FirecrackerOrchestrator
 * (../orchestrator.ts). Both need the same guarantee — an
 * `http(s)://<IPv4>[:port]` literal, because Firecracker guests have no DNS
 * resolver — and the orchestrator additionally needs the parsed ip:port to
 * open the host firewall for guest→platform traffic. One parser returns
 * both: the normalized URL (trailing slashes stripped) and the { ip, port }.
 *
 * Fail-fast: an invalid URL must surface as a boot-time configuration error,
 * never as an opaque in-guest network timeout at first run.
 */

export interface ParsedPlatformApiUrl {
  /** Input with trailing slashes stripped — advertised to guests verbatim. */
  url: string;
  /** IPv4 literal the host firewall must let guests reach. */
  ip: string;
  /** Port, with the scheme default filled in (80 http / 443 https). */
  port: number;
}

export function parsePlatformApiUrl(raw: string): ParsedPlatformApiUrl {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      `platform API URL is not a valid URL: "${raw}" — expected http(s)://<IPv4>[:port]`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `platform API URL must use http or https (got "${parsed.protocol}//" in "${raw}") — ` +
        `expected http(s)://<IPv4>[:port]`,
    );
  }
  // The WHATWG parser has already normalized/validated numeric hosts
  // (e.g. "999.0.0.1" or "0x7f.1" never reach here as-is) — anything still
  // dotted-quad shaped is a well-formed IPv4 literal.
  const ip = parsed.hostname;
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    throw new Error(
      `platform API URL host must be an IPv4 literal (got "${ip}" in "${raw}") — guests have ` +
        `no DNS resolver, so a hostname would never resolve in-guest`,
    );
  }
  // URL normalizes an explicit default port away (":80"/":443" → "") —
  // re-derive it from the scheme.
  const port = parsed.port !== "" ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
  return { url: raw.replace(/\/+$/, ""), ip, port };
}
