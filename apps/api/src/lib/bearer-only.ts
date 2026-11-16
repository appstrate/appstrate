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

import type { Context } from "hono";
import type { AppEnv } from "../types/index.ts";
import { forbidden } from "./errors.ts";

/**
 * Auth methods accepted by the bearer-only proxy surfaces. The value is the
 * `c.get("authMethod")` string set by the auth pipeline.
 *
 * This IS a hard-coded allowlist, and two of its entries (`oauth2-instance`,
 * `oauth2-dashboard`) are strategy ids owned by the `oidc` module — core names
 * them explicitly because an allowlist that any loaded module could widen would
 * not be a security boundary. Adding a bearer strategy here is therefore a
 * deliberate core change, not a module capability. (The *declared*
 * capabilities that bypass it, one per surface, are below.)
 */
const ACCEPTED_AUTH_METHODS: ReadonlySet<string> = new Set([
  "api_key",
  "oauth2-instance",
  "oauth2-dashboard",
]);

/**
 * The bearer-only surfaces, each with the DECLARED capability (`AuthResolution`,
 * `@appstrate/core/module`) that admits a caller outside the allowlist. Read from
 * the request context, never from a module id, so any future strategy declaring
 * one works unchanged. (The allowlist above is the opposite by design: an
 * explicit, core-owned set of strategy ids.)
 *
 * - The credential proxy refuses a cookie for one reason: a drive-by CSRF would
 *   spend the user's third-party credentials. A `serverMinted` bearer (a token the
 *   server built for its own calls, never reachable from a browser) carries no
 *   such risk, so it is admitted — the chat's MCP bearer and its inference bearer.
 * - The LLM proxy admits only `firstPartyLoopback`, the chat's inference bearer:
 *   it books the call as chat usage and may reach the subscription gateway, which
 *   no other server-minted bearer is for.
 */
const SURFACES = {
  "credential-proxy": { label: "Credential proxy", capability: "serverMinted" },
  "llm-proxy": { label: "LLM proxy", capability: "firstPartyLoopback" },
} as const;

export type BearerOnlySurface = keyof typeof SURFACES;

/** What the bearer-only rule reads of a caller: its auth method and declared capabilities. */
export interface BearerCaller {
  authMethod?: string;
  serverMinted?: boolean;
  firstPartyLoopback?: boolean;
}

/** The caller of a request, as {@link isBearerOnlyCaller} reads it. */
export function bearerCaller(c: Context<AppEnv>): BearerCaller {
  return {
    authMethod: c.get("authMethod"),
    serverMinted: c.get("serverMinted"),
    firstPartyLoopback: c.get("firstPartyLoopback"),
  };
}

/** Whether the caller passes `surface`'s bearer-only rule: an allowlisted bearer, or its capability. */
export function isBearerOnlyCaller(caller: BearerCaller, surface: BearerOnlySurface): boolean {
  if (caller[SURFACES[surface].capability] === true) return true;
  return !!caller.authMethod && ACCEPTED_AUTH_METHODS.has(caller.authMethod);
}

/** Throw `forbidden(...)` unless {@link isBearerOnlyCaller} holds. */
export function assertBearerOnly(caller: BearerCaller, surface: BearerOnlySurface): void {
  if (!isBearerOnlyCaller(caller, surface)) {
    throw forbidden(
      `${SURFACES[surface].label} does not accept auth method "${caller.authMethod}" (cookie sessions and unknown strategies rejected)`,
    );
  }
}
