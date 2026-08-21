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
 *
 * This IS a hard-coded allowlist, and two of its entries (`oauth2-instance`,
 * `oauth2-dashboard`) are strategy ids owned by the `oidc` module — core names
 * them explicitly because an allowlist that any loaded module could widen would
 * not be a security boundary. Adding a bearer strategy here is therefore a
 * deliberate core change, not a module capability. (The one *declared*
 * capability that bypasses the list is `firstPartyLoopback` — see below.)
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
 * a browser. Core gates on this declared property, so the *loopback* bypass
 * names no module id — any future first-party loopback strategy works
 * unchanged. (The bearer allowlist above is the opposite by design: an
 * explicit, core-owned set of strategy ids.)
 */
interface BearerCallerCapabilities {
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
