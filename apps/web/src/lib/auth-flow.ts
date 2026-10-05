// SPDX-License-Identifier: Apache-2.0

/**
 * The decisions of the built-in (non-OIDC) auth screens, as pure functions:
 * where a visitor goes next and what an auth response means. The components
 * and `use-auth` only carry them out.
 */

import { EmailNotVerifiedError, hasVerificationLinkError } from "./auth-errors";

/** A react-router destination. */
interface Destination {
  to: string;
  state?: { email: string; callbackURL?: string };
}

/**
 * Where a signed-out visitor lands outside the auth routes. A verification
 * link that could not be honoured redirects to its callback URL with
 * `?error=` — say so, rather than dropping the visitor on a bare login form.
 */
export function signedOutDestination(search: string): string {
  return hasVerificationLinkError(search) ? `/verify-email${search}` : "/login";
}

/**
 * Where a failed sign-in sends the user, or `null` when the form should show
 * the error. An unverified account goes to the "check your inbox" screen,
 * which re-sends a link that lands on `callbackURL`.
 */
export function loginFailureDestination(
  error: unknown,
  email: string,
  callbackURL: string | undefined,
): Destination | null {
  if (!(error instanceof EmailNotVerifiedError)) return null;
  return { to: "/verify-email", state: { email, callbackURL } };
}

/**
 * Whether an immediate (no email verification) change of address took effect.
 * Better Auth answers 200 whether or not the requested address was free — it
 * never says that an address has an account — so the session is what tells.
 */
export function emailWasChanged(requested: string, sessionEmail: string | undefined): boolean {
  return sessionEmail === requested.trim().toLowerCase();
}

/**
 * The page both email-change links (approval, then verification) land on. It
 * names no address: the page shows the account's own, and a crafted link can
 * make it say nothing false.
 */
export const EMAIL_CHANGE_CALLBACK_URL = "/preferences?email_change=1";

/**
 * What the settings page says about the email-change link that led to it:
 * `failed` when Better Auth reports it could not be honoured, `accepted`
 * otherwise, `null` on an ordinary visit.
 */
export function emailChangeLanding(search: string): "failed" | "accepted" | null {
  if (!new URLSearchParams(search).has("email_change")) return null;
  return hasVerificationLinkError(search) ? "failed" : "accepted";
}
