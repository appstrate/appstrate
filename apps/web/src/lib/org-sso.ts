// SPDX-License-Identifier: Apache-2.0

/**
 * Enterprise sign-in (`/api/org-sso*`, contributed by the commercial module behind
 * `features.enterpriseSso`): the request pieces the SPA sends, and the rules the settings page
 * and the sign-in form read off the server's answers. Pure, so each is pinned by a test.
 */

import type { components } from "../api/client";
import { hasVerificationLinkError } from "./auth-errors";
import type { RoutePath } from "./route-access";

export type SsoSettings = components["schemas"]["SsoSettings"];
export type SsoDomain = components["schemas"]["SsoDomain"];
export type SsoJoinRole = SsoSettings["join_role"];

/** The settings page: where a Microsoft sign-in started from it comes back. */
export const ORG_SSO_PATH = "/org-settings/enterprise-sso" satisfies RoutePath;

/** Set on the return of the Microsoft sign-in that "Connect your tenant" starts: the page then binds the tenant once. */
export const SSO_CONNECT_PARAM = "connect";

/** `POST /api/org-sso/domains`. The server normalizes and validates (`invalid_domain`); only the blanks around a paste go. */
export function ssoDomainBody(input: string): { domain: string } {
  return { domain: input.trim() };
}

/** `PATCH /api/org-sso`. */
export function ssoJoinRoleBody(role: SsoJoinRole): { join_role: SsoJoinRole } {
  return { join_role: role };
}

/** The query of an owner's emergency password sign-in (`POST /api/auth/sign-in/email?emergency=1`). */
export const EMERGENCY_SIGN_IN_QUERY = { emergency: "1" } as const;

/** Why the enforcement cannot be turned on yet, in the order the owner fixes it; `null` when it can. */
export type EnforcementBlocker = "no_tenant" | "no_verified_domain" | "other_session";

export function enforcementBlocker(settings: SsoSettings): EnforcementBlocker | null {
  if (!settings.tenant_id) return "no_tenant";
  if (!settings.domains.some((domain) => domain.verified)) return "no_verified_domain";
  // The server ends every other session of the domains' accounts: only a session the bound
  // tenant opened may do it, so the owner never locks themselves out.
  if (settings.caller_tenant_id !== settings.tenant_id) return "other_session";
  return null;
}

/** The refusals of the organization's sign-in policy, as a sign-in or its callback reports them. */
const SSO_REFUSAL_CODES = ["sso_required", "sso_tenant_mismatch"] as const;
type SsoRefusalCode = (typeof SSO_REFUSAL_CODES)[number];

export function isSsoRefusal(code: string | null | undefined): code is SsoRefusalCode {
  return (SSO_REFUSAL_CODES as readonly string[]).includes(code ?? "");
}

/** Better Auth's callback error parameters, added to the error callback URL of a social sign-in. */
const CALLBACK_ERROR_PARAMS = ["error", "error_description"];

/** `path` + `search` without a previous callback error, so the next one is the only `?error=`. */
export function errorCallbackURL(pathname: string, search: string): string {
  const params = new URLSearchParams(search);
  for (const name of CALLBACK_ERROR_PARAMS) params.delete(name);
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

/**
 * The code a social sign-in's callback came back with (`?error=`), or `null`. A verification
 * link's own errors are left to the page that asked for the link (`hasVerificationLinkError`).
 */
export function socialCallbackError(search: string): string | null {
  if (hasVerificationLinkError(search)) return null;
  return new URLSearchParams(search).get("error") || null;
}
