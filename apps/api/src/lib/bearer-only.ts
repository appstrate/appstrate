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
