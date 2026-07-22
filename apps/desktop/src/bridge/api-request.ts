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
 * Exfiltration guard: `url` must live under the same registrable
 * domain as the page the auth was read from — `auth_script` + an
 * attacker URL would otherwise be a token oracle. Heuristic eTLD+1
 * suffix match (api.foo.com vs www.foo.com passes; evil.test fails);
 * not a full Public Suffix List, documented as such.
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

/** Last two DNS labels — a pragmatic eTLD+1 stand-in (documented above). */
function registrableSuffix(hostname: string): string {
  return hostname.split(".").slice(-2).join(".");
}

export async function apiRequest(
  wc: WebContents,
  raw: unknown,
): Promise<{ status: number; content_type: string; body: string; truncated: boolean }> {
  const p = raw as ApiRequestParams;
  if (!p || typeof p.url !== "string" || !/^https:\/\//.test(p.url)) {
    throw new ApiRequestError(ERR_INVALID_PARAMS, "api_request requires an https URL");
  }
  const pageHost = new URL(wc.getURL() || "https://invalid.invalid").hostname;
  const targetHost = new URL(p.url).hostname;
  if (registrableSuffix(pageHost) !== registrableSuffix(targetHost)) {
    throw new ApiRequestError(
      ERR_INVALID_PARAMS,
      `api_request is bound to the page's domain (${registrableSuffix(pageHost)}); refusing ${targetHost}`,
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
