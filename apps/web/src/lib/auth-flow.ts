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

/** Query parameter the email-change links carry back to the settings page. */
const EMAIL_CHANGE_PARAM = "email_change";

/** The page both email-change links (approval, then verification) land on. */
export function emailChangeCallbackURL(newEmail: string): string {
  return `/preferences?${new URLSearchParams({ [EMAIL_CHANGE_PARAM]: newEmail.trim().toLowerCase() })}`;
}

/**
 * What an email-change link did, read from the settings page it landed on:
 * - `failed`: the link was invalid, expired or opened under another account;
 * - `approved`: the current address approved, the new one must now verify;
 * - `changed`: the new address verified, the account uses it.
 * `null` for an ordinary visit.
 */
export function emailChangeLanding(
  search: string,
  sessionEmail: string,
): { kind: "failed" | "changed" } | { kind: "approved"; email: string } | null {
  const requested = new URLSearchParams(search).get(EMAIL_CHANGE_PARAM);
  if (requested === null) return null;
  if (hasVerificationLinkError(search)) return { kind: "failed" };
  return requested === sessionEmail.toLowerCase()
    ? { kind: "changed" }
    : { kind: "approved", email: requested };
}

/**
 * Whether the auth client should navigate the page after a successful call.
 * Better Auth answers `{ redirect: true, url }` to say "go there": that is how
 * a social sign-in reaches its provider. Email sign-in answers the same as
 * soon as it is given a `callbackURL` — which this SPA passes only to aim the
 * verification email — and the SPA routes itself after that sign-in, so a
 * full-page navigation there would reload the screen the user is on.
 */
export function followsAuthRedirect(
  requestPath: string,
  data: { redirect?: unknown; url?: unknown } | null | undefined,
): data is { redirect: true; url: string } {
  if (!data || data.redirect !== true || typeof data.url !== "string") return false;
  if (requestPath.endsWith("/sign-in/email")) return false;
  try {
    const { protocol } = new URL(data.url);
    return protocol === "https:" || protocol === "http:";
  } catch {
    // Not absolute: a path on this origin.
    return true;
  }
}

/**
 * Wrap `action` so every call first waits for `gate` to settle.
 *
 * The boot session resync signs out when it finds no session, and that
 * response deletes whatever session cookie exists by the time it lands. A
 * sign-in sent while it is in flight would lose the cookie it was just given,
 * so sign-in and sign-up are gated on it.
 */
export function afterGate<Args extends unknown[], R>(
  gate: () => Promise<unknown>,
  action: (...args: Args) => Promise<R>,
): (...args: Args) => Promise<R> {
  return async (...args) => {
    await gate();
    return action(...args);
  };
}
