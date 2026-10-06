// SPDX-License-Identifier: Apache-2.0

/** Decisions of the built-in (non-OIDC) auth screens, as pure functions. */

import { hasVerificationLinkError } from "./auth-errors";

/** Where a signed-out visitor lands outside the auth routes; a failed verification link says so. */
export function signedOutDestination(search: string): string {
  return hasVerificationLinkError(search) ? `/verify-email${search}` : "/login";
}

/** Better Auth answers 200 whether or not the address was free: the session tells if it changed. */
export function emailWasChanged(requested: string, sessionEmail: string | undefined): boolean {
  return sessionEmail === requested.trim().toLowerCase();
}

/**
 * Where both email-change links land: the route rendering the form (`/preferences`
 * redirects there and drops the query). No address, so a crafted link prints none.
 */
export const EMAIL_CHANGE_CALLBACK_URL = "/preferences/general?email_change=1";

/** What the settings page reports about the email-change link that led to it. */
export function emailChangeLanding(search: string): "failed" | "accepted" | null {
  if (!new URLSearchParams(search).has("email_change")) return null;
  return hasVerificationLinkError(search) ? "failed" : "accepted";
}
