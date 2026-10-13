// SPDX-License-Identifier: Apache-2.0

/**
 * The ONE request-header policy of both LLM proxies — the run sidecar's
 * `/llm/*` and the platform's `/api/llm-proxy/*`. Everything the caller's SDK
 * (Pi) sent is forwarded, so a provider-specific header (`x-opencode-session`,
 * OpenRouter's `http-referer`, the next provider's) is never silently lost;
 * only what must not cross the proxy is dropped:
 *   - transport: `host`, `content-length`, `accept-encoding` (the proxy's own
 *     fetch negotiates and decodes the body) and RFC 7230 hop-by-hop;
 *   - what describes the platform's own inbound request
 *     (`./platform-request-headers.ts`, the rule the credential proxy reads
 *     too): the caller's platform credential, its tenancy and run, the
 *     platform's markers, the network path to the platform and the identity
 *     an auth proxy in front of it asserts;
 *   - vendor credential slots (`x-api-key`, `x-goog-api-key`, `api-key`): each
 *     proxy sets its own upstream auth;
 *   - vendor account scoping: `openai-organization`, `openai-project` (a
 *     stored credential decides whose account is billed, never the caller);
 *   - request rewriting honoured by some gateways (`x-http-method-override`,
 *     `x-original-url`, …): the proxy decides the method and path.
 * Header-level billing guards (Anthropic's `anthropic-beta` filter) stay with
 * the caller and run on the result.
 */

import { HOP_BY_HOP_HEADERS } from "@appstrate/afps-runtime/resolvers";
import { isPlatformRequestHeader } from "./platform-request-headers.ts";

const DROPPED = new Set([
  ...HOP_BY_HOP_HEADERS,
  // Vendor credential slots, never forwarded: each proxy sets its own auth.
  "x-api-key",
  "x-goog-api-key",
  "api-key",
  "cf-access-client-id",
  "cf-access-client-secret",
  "host",
  "content-length",
  "accept-encoding",
  "openai-organization",
  "openai-project",
  "x-http-method-override",
  "x-http-method",
  "x-method-override",
  "x-original-url",
  "x-rewrite-url",
]);

/** The headers to send upstream; the caller sets its own upstream auth on the result. */
export function forwardedLlmRequestHeaders(incoming: Headers | Record<string, string>): Headers {
  const out = new Headers();
  new Headers(incoming).forEach((value, name) => {
    if (isPlatformRequestHeader(name) || DROPPED.has(name)) return;
    out.set(name, value);
  });
  return out;
}
