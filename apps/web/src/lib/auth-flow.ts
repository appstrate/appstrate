// SPDX-License-Identifier: Apache-2.0

/** Decisions of the built-in (non-OIDC) auth screens, as pure functions. */

import { hasVerificationLinkError } from "./auth-errors";

/** Where a signed-out visitor lands outside the auth routes; a failed verification link says so. */
export function signedOutDestination(search: string): string {
  if (new URLSearchParams(search).has("email_change")) return "/login";
  return hasVerificationLinkError(search) ? `/verify-email${search}` : "/login";
}

/** Better Auth answers 200 whether or not the address was free: the session tells if it changed. */
export function emailWasChanged(requested: string, sessionEmail: string | undefined): boolean {
  return sessionEmail === requested.trim().toLowerCase();
}

/** The route rendering the form (`/preferences` redirects there and drops the query). Carries no address, so a crafted link prints none. */
export const EMAIL_CHANGE_CALLBACK_URL = "/preferences/general?email_change=1";

export function emailChangeLanding(search: string): "failed" | "refused" | "accepted" | null {
  const params = new URLSearchParams(search);
  if (!params.has("email_change")) return null;
  if (params.get("error") === "email_change_refused") return "refused";
  return hasVerificationLinkError(search) ? "failed" : "accepted";
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
