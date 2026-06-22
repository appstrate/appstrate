// SPDX-License-Identifier: Apache-2.0

/**
 * Shared bearer-only auth gate for the public proxy surfaces (LLM proxy +
 * credential proxy). Both accept the same three bearer auth methods —
 * headless API keys (`api_key`) and device-flow / dashboard OIDC JWTs
 * (`oauth2-instance`, `oauth2-dashboard`) — and reject cookie sessions
 * (`session`) plus any unknown strategy id. Cookie sessions are refused
 * because the drive-by CSRF threat model doesn't fit endpoints that reach
 * third-party providers / mint per-call usage on behalf of a logged-in user.
 */

import { forbidden } from "./errors.ts";

/**
 * Auth methods accepted by the bearer-only proxy surfaces. The value is the
 * `c.get("authMethod")` string set by the auth pipeline.
 */
const ACCEPTED_AUTH_METHODS: ReadonlySet<string> = new Set([
  "api_key",
  "oauth2-instance",
  "oauth2-dashboard",
  // In-process loopback bearer minted by the chat module for its own
  // inference calls (process-local secret, 60s TTL, llm-proxy:call +
  // models:read only). A server-constructed request — the cookie/CSRF
  // threat model doesn't apply. See packages/module-chat/src/loopback-auth.ts.
  "chat-loopback",
]);

/**
 * Throw `forbidden(...)` unless `authMethod` is one of the accepted bearer
 * strategies. `surfaceName` is the human-readable surface noun used in the
 * error message (e.g. "LLM proxy", "Credential proxy").
 */
export function assertBearerOnly(authMethod: string | undefined, surfaceName: string): void {
  if (!authMethod || !ACCEPTED_AUTH_METHODS.has(authMethod)) {
    throw forbidden(
      `${surfaceName} does not accept auth method "${authMethod}" (cookie sessions and unknown strategies rejected)`,
    );
  }
}

/**
 * The ONLY auth method allowed to drive a subscription LLM gateway: the chat
 * module's in-process loopback bearer. The effective gate is the loopback HMAC
 * secret (process-local, never persisted/transmitted — see
 * packages/module-chat/src/loopback-auth.ts), which only a server-constructed
 * request carries.
 *
 * `oauth2-dashboard` is deliberately EXCLUDED: a logged-in org member could
 * otherwise point a normal dashboard token at the gateway and use it as a raw
 * subscription proxy — driving the upstream as a NON-official client. That
 * defeats the whole "the official binary signs its own fingerprint" argument,
 * since the gateway forges nothing and would then relay arbitrary client
 * traffic on the subscription. Restricting to `chat-loopback` keeps the
 * subscription reachable only through the official Claude Agent SDK path.
 *
 * Widening this set, or persisting/exporting the loopback secret, breaks the
 * invariant that a personal subscription is never spendable as a bare proxy.
 */
const LOOPBACK_ONLY_AUTH_METHODS: ReadonlySet<string> = new Set(["chat-loopback"]);

/**
 * Throw `forbidden(...)` unless the caller is the chat loopback bearer. Still
 * rejects cookie sessions / unknown strategies via {@link assertBearerOnly}
 * first, then narrows to loopback-only.
 */
export function assertLoopbackOnly(authMethod: string | undefined, surfaceName: string): void {
  assertBearerOnly(authMethod, surfaceName);
  if (!authMethod || !LOOPBACK_ONLY_AUTH_METHODS.has(authMethod)) {
    throw forbidden(
      `${surfaceName} is restricted to the chat loopback caller — subscription credentials are never spendable through API keys, dashboard tokens, or external tokens`,
    );
  }
}
