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
]);

/**
 * Declared capability of the calling auth strategy, read from the request
 * context (NOT a hard-coded module id). A strategy sets
 * {@link AuthResolution.firstPartyLoopback} when it is a server-minted,
 * process-local loopback bearer (the chat module's inference path is the only
 * one today): a request the server constructed for itself, never reachable from
 * a browser. Core gates on this declared property so no specific module id is
 * special-cased here — any future first-party loopback strategy works unchanged.
 */
export interface BearerCallerCapabilities {
  /** Strategy declared itself a first-party, server-minted loopback caller. */
  firstPartyLoopback?: boolean;
}

/**
 * Throw `forbidden(...)` unless the caller is an accepted bearer strategy. Pass
 * `caps.firstPartyLoopback` (from `c.get("firstPartyLoopback")`) so a declared
 * first-party loopback strategy is accepted without enumerating its id here.
 * `surfaceName` is the human-readable surface noun used in the error message.
 */
export function assertBearerOnly(
  authMethod: string | undefined,
  surfaceName: string,
  caps: BearerCallerCapabilities = {},
): void {
  if (caps.firstPartyLoopback) return;
  if (!authMethod || !ACCEPTED_AUTH_METHODS.has(authMethod)) {
    throw forbidden(
      `${surfaceName} does not accept auth method "${authMethod}" (cookie sessions and unknown strategies rejected)`,
    );
  }
}

/**
 * Throw `forbidden(...)` unless the caller is a first-party loopback bearer —
 * the only caller allowed to drive a subscription LLM gateway. The effective
 * gate is the strategy's process-local HMAC secret (never persisted/transmitted),
 * which only a server-constructed request carries; core merely reads the
 * `firstPartyLoopback` capability the strategy declared.
 *
 * Everything else — including `oauth2-dashboard` — is refused: a logged-in org
 * member could otherwise point a normal dashboard token at the gateway and use
 * it as a raw subscription proxy, driving the upstream as a NON-official client
 * and defeating the "official binary signs its own fingerprint" argument.
 * Persisting/exporting a loopback secret, or declaring `firstPartyLoopback` on a
 * browser-reachable strategy, breaks the invariant that a personal subscription
 * is never spendable as a bare proxy.
 */
export function assertLoopbackOnly(
  authMethod: string | undefined,
  surfaceName: string,
  caps: BearerCallerCapabilities = {},
): void {
  assertBearerOnly(authMethod, surfaceName, caps);
  if (!caps.firstPartyLoopback) {
    throw forbidden(
      `${surfaceName} is restricted to the first-party loopback caller — subscription credentials are never spendable through API keys, dashboard tokens, or external tokens`,
    );
  }
}
