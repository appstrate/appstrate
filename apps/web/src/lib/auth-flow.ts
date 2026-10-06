// SPDX-License-Identifier: Apache-2.0

/** Decisions of the built-in (non-OIDC) auth screens, as pure functions. */

import { hasVerificationLinkError } from "./auth-errors";

/**
 * Where a signed-out visitor lands outside the auth routes; a failed sign-up verification link
 * says so. An email-change link is not one: its landing belongs to a signed-in account.
 */
export function signedOutDestination(search: string): string {
  if (new URLSearchParams(search).has("email_change")) return "/login";
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

const EMAIL_CHANGE_REQUEST_KEY = "appstrate_email_change_requested";

/** The links carry no address: the browser that asked keeps it, to recognise the change once made. */
export function rememberEmailChangeRequest(storage: Storage, requested: string): void {
  storage.setItem(EMAIL_CHANGE_REQUEST_KEY, requested.trim().toLowerCase());
}

export function requestedEmailChange(storage: Storage): string | null {
  return storage.getItem(EMAIL_CHANGE_REQUEST_KEY);
}

/**
 * What the settings page reports about the email-change link that led to it. Both links land
 * here: `changed` once the session carries the address this browser asked for, `accepted` before
 * that (or from another browser), `refused` for an address the instance reserves.
 */
export function emailChangeLanding(
  search: string,
  sessionEmail?: string,
  requested?: string | null,
): "failed" | "refused" | "changed" | "accepted" | null {
  const params = new URLSearchParams(search);
  if (!params.has("email_change")) return null;
  if (params.get("error") === "email_change_refused") return "refused";
  if (hasVerificationLinkError(search)) return "failed";
  return requested && emailWasChanged(requested, sessionEmail) ? "changed" : "accepted";
}
