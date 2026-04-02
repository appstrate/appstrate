// SPDX-License-Identifier: Apache-2.0

// Pure functions and constants extracted from server.ts for testability.

export { isBlockedHost, isBlockedUrl } from "./ssrf.ts";

// Accepts both simple IDs (gmail) and scoped IDs (@appstrate/gmail)
export const PROVIDER_ID_RE = /^(@[a-z0-9][a-z0-9-]*\/)?[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

export const MAX_RESPONSE_SIZE = 50_000;
export const ABSOLUTE_MAX_RESPONSE_SIZE = 1_000_000; // 1MB
export const OUTBOUND_TIMEOUT_MS = 30_000;
export const MAX_SUBSTITUTE_BODY_SIZE = 5 * 1024 * 1024; // 5MB
export const LLM_PROXY_TIMEOUT_MS = 300_000; // 5 minutes

export interface LlmProxyConfig {
  baseUrl: string;
  apiKey: string;
  placeholder: string;
}

export interface SidecarConfig {
  runToken: string;
  platformApiUrl: string;
  proxyUrl?: string;
  llm?: LlmProxyConfig;
}

export interface CredentialsResponse {
  credentials: Record<string, string>;
  authorizedUris: string[] | null;
  allowAllUris: boolean;
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
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "proxy-authorization",
]);

/** Strip host, content-length, and hop-by-hop headers. Optionally skip additional header names (lowercase). */
export function filterHeaders(
  headers: Record<string, string>,
  extraSkip?: Set<string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (
      lower === "host" ||
      lower === "content-length" ||
      HOP_BY_HOP_HEADERS.has(lower) ||
      extraSkip?.has(lower)
    )
      continue;
    out[key] = value;
  }
  return out;
}

export function matchesAuthorizedUri(url: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern.endsWith("*")) {
      return url.startsWith(pattern.slice(0, -1));
    }
    return url === pattern;
  });
}
