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
 *   - client network identity: `forwarded`, `via`, `x-forwarded-*`,
 *     `x-real-ip`, `true-client-ip`, Cloudflare's edge `cf-*` headers.
 * Header-level billing guards (Anthropic's `anthropic-beta` filter) stay with
 * the caller and run on the result.
 */

import { HOP_BY_HOP_HEADERS } from "./proxy-primitives.ts";

/** The auth slots pi-ai's SDKs write the provider key into. */
const CREDENTIAL_SLOTS = new Set(["authorization", "x-api-key", "x-goog-api-key", "api-key"]);

const DROPPED = new Set([
  ...HOP_BY_HOP_HEADERS,
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
  "cf-connecting-ip",
  "cf-connecting-ipv6",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "cf-worker",
]);

const DROPPED_PREFIXES = ["x-appstrate-", "appstrate-", "x-forwarded-"];

/** A placeholder the caller's SDK put in its auth slot, and the real key it stands for. */
export interface CredentialPlaceholder {
  placeholder: string;
  secret: string;
}

/**
 * The headers to send upstream. With `credential`, the auth slot carrying its
 * placeholder is kept with the secret swapped in (the sidecar's api-key mode);
 * every other inbound credential is dropped.
 */
export function forwardedLlmRequestHeaders(
  incoming: Headers | Record<string, string>,
  credential?: CredentialPlaceholder,
): Headers {
  const out = new Headers();
  new Headers(incoming).forEach((value, name) => {
    if (DROPPED.has(name) || DROPPED_PREFIXES.some((prefix) => name.startsWith(prefix))) return;
    if (!CREDENTIAL_SLOTS.has(name)) {
      out.set(name, value);
    } else if (credential && value.includes(credential.placeholder)) {
      out.set(name, value.replace(credential.placeholder, credential.secret));
    }
  });
  return out;
}
