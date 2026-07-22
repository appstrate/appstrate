// SPDX-License-Identifier: Apache-2.0

/**
 * `browser.api_request` — authenticated API calls whose credentials
 * never leave the user's machine.
 *
 * The mechanical closing of the last prompt-discipline gap: until now,
 * calling a page's own API required an in-page `evaluate` script that
 * read the session token and merely PROMISED not to return it. Here the
 * token's whole life cycle is local:
 *
 *   1. `auth_script` (frozen in a skill, visible code, no secret) runs
 *      in the page and returns the Authorization header VALUE — which
 *      goes straight into a local variable, never onto the WebSocket.
 *   2. The request is made through the PAGE'S OWN SESSION
 *      (`session.fetch`: same cookies), with that header attached.
 *   3. The response body is scrubbed of the auth value before leaving
 *      the machine (an API echoing its bearer is rare but real).
 *
 * Exfiltration guard: `url`'s host must EQUAL the host of the page the
 * auth is read from — `auth_script` + an attacker URL would otherwise
 * be a token oracle. Exact host match (not eTLD+1): a registrable-domain
 * heuristic without the Public Suffix List mishandles `foo.co.uk`-style
 * suffixes, and same-registrable-domain still lets `evil.github.io`
 * read a token from `victim.github.io`. Exact host is the correct
 * boundary for a bearer, and costs only that an API on a sibling
 * subdomain must be reached by navigating there first. IP-literal hosts
 * are refused outright, and a request with no page loaded is refused
 * rather than folded into a shared sentinel.
 */

import type { WebContents } from "electron";
import { ERR_INVALID_PARAMS } from "./protocol.ts";

export interface ApiRequestParams {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /**
   * In-page script whose return value becomes the `Authorization`
   * header. Runs locally; its result is used and discarded.
   */
  auth_script?: string;
  /** Cap on the returned body (default 256 KiB) — bigger payloads belong to browser.download. */
  max_body_bytes?: number;
}

class ApiRequestError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

const DEFAULT_MAX_BODY = 256 * 1024;

/** Normalize a hostname for exact comparison: lowercase, strip a trailing dot. */
function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, "");
}

/** IPv4-literal, bracketed IPv6, or bare IPv6 — refused so a host can't be an IP. */
function isIpLiteral(hostname: string): boolean {
  return (
    /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":") || hostname.startsWith("[")
  );
}

export async function apiRequest(
  wc: WebContents,
  raw: unknown,
): Promise<{ status: number; content_type: string; body: string; truncated: boolean }> {
  const p = raw as ApiRequestParams;
  if (!p || typeof p.url !== "string" || !/^https:\/\//.test(p.url)) {
    throw new ApiRequestError(ERR_INVALID_PARAMS, "api_request requires an https URL");
  }
  const pageUrl = wc.getURL();
  if (!pageUrl || !/^https?:\/\//.test(pageUrl)) {
    throw new ApiRequestError(ERR_INVALID_PARAMS, "api_request needs a loaded https page");
  }
  const pageHost = normalizeHost(new URL(pageUrl).hostname);
  const targetHost = normalizeHost(new URL(p.url).hostname);
  if (isIpLiteral(pageHost) || isIpLiteral(targetHost)) {
    throw new ApiRequestError(ERR_INVALID_PARAMS, "api_request refuses IP-literal hosts");
  }
  if (pageHost !== targetHost) {
    throw new ApiRequestError(
      ERR_INVALID_PARAMS,
      `api_request is bound to the page's host (${pageHost}); refusing ${targetHost}`,
    );
  }

  let authValue: string | null = null;
  if (p.auth_script) {
    const result: unknown = await wc.executeJavaScript(p.auth_script, true);
    if (typeof result !== "string" || result.length === 0) {
      throw new ApiRequestError(
        ERR_INVALID_PARAMS,
        "auth_script must return a non-empty string (the Authorization header value)",
      );
    }
    authValue = result;
  }

  const res = await wc.session.fetch(p.url, {
    method: p.method ?? "GET",
    headers: {
      ...(p.headers ?? {}),
      ...(authValue ? { Authorization: authValue } : {}),
    },
    ...(p.body !== undefined ? { body: p.body } : {}),
  });

  const cap = Math.min(Math.max(p.max_body_bytes ?? DEFAULT_MAX_BODY, 1024), 4 * 1024 * 1024);
  const text = await res.text();
  const truncated = text.length > cap;
  let body = truncated ? text.slice(0, cap) : text;
  // The token was born and used locally — make sure an echoing API
  // cannot smuggle it out in the response either.
  if (authValue && body.includes(authValue)) {
    body = body.split(authValue).join("[redacted:local-auth]");
  }
  return {
    status: res.status,
    content_type: res.headers.get("content-type") ?? "",
    body,
    truncated,
  };
}
