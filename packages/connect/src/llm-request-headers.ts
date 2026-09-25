// SPDX-License-Identifier: Apache-2.0

/**
 * The ONE request-header policy of both LLM proxies — the run sidecar's
 * `/llm/*` and the platform's `/api/llm-proxy/*`. Everything the caller's SDK
 * (Pi) sent is forwarded, so a provider-specific header (`x-opencode-session`,
 * OpenRouter's `http-referer`, the next provider's) is never silently lost;
 * only what must not cross the proxy is dropped:
 *   - transport: `host`, `content-length`, `accept-encoding` (the proxy's own
 *     fetch negotiates and decodes the body) and RFC 7230 hop-by-hop;
 *   - inbound credentials: each proxy sets its own upstream auth;
 *   - platform-internal: `x-appstrate-*`, `appstrate-*`, `x-org-id`,
 *     `x-space-id`, `x-run-id`;
 *   - vendor account scoping: `openai-organization`, `openai-project` (a
 *     stored credential decides whose account is billed, never the caller);
 *   - client network identity: `forwarded`, `via`, `x-forwarded-*`,
 *     `x-real-ip`, `true-client-ip`, `x-client-ip`, `x-original-forwarded-for`,
 *     `cdn-loop`, every Cloudflare `cf-*` header;
 *   - identity asserted by an auth proxy in front of the caller (AWS ALB OIDC,
 *     Azure App Service, Google IAP, oauth2-proxy);
 *   - request rewriting honoured by some gateways (`x-http-method-override`,
 *     `x-original-url`, …): the proxy decides the method and path.
 * Header-level billing guards (Anthropic's `anthropic-beta` filter) stay with
 * the caller and run on the result.
 */

import { HOP_BY_HOP_HEADERS } from "./proxy-primitives.ts";

const DROPPED = new Set([
  ...HOP_BY_HOP_HEADERS,
  // Inbound credential slots, never forwarded: each proxy sets its own auth.
  "authorization",
  "x-api-key",
  "x-goog-api-key",
  "api-key",
  "host",
  "content-length",
  "accept-encoding",
  "cookie",
  "x-org-id",
  "x-space-id",
  "x-run-id",
  "forwarded",
  "via",
  "x-real-ip",
  "true-client-ip",
  "x-client-ip",
  "x-original-forwarded-for",
  "cdn-loop",
  "openai-organization",
  "openai-project",
  "x-http-method-override",
  "x-http-method",
  "x-method-override",
  "x-original-url",
  "x-rewrite-url",
]);

const DROPPED_PREFIXES = [
  "x-appstrate-",
  "appstrate-",
  "x-forwarded-",
  "cf-",
  "x-amzn-oidc-",
  "x-ms-client-principal",
  "x-ms-token-",
  "x-goog-iap-",
  "x-goog-authenticated-user-",
  "x-auth-request-",
];

/** The headers to send upstream; the caller sets its own upstream auth on the result. */
export function forwardedLlmRequestHeaders(incoming: Headers | Record<string, string>): Headers {
  const out = new Headers();
  new Headers(incoming).forEach((value, name) => {
    if (DROPPED.has(name) || DROPPED_PREFIXES.some((prefix) => name.startsWith(prefix))) return;
    out.set(name, value);
  });
  return out;
}
