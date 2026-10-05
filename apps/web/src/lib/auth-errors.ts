// SPDX-License-Identifier: Apache-2.0

/**
 * Thrown by `unlinkAccount()` (and any other fresh-gated action) when Better
 * Auth rejects the request with `SESSION_NOT_FRESH`. Callers catch this
 * discriminant (via `instanceof`, never message sniffing — the BA message is
 * localizable/unstable) to walk the user through a step-up re-login instead of
 * surfacing a raw error.
 */
export class SessionNotFreshError extends Error {}

/**
 * Map a raw Better Auth error into the SPA error type. Isolated as a pure
 * function so the mapping is unit-testable without a rendering harness.
 */
export function toUnlinkError(error: { code?: string | null; message?: string | null }): Error {
  const message = error.message ?? "";
  if (error.code === "SESSION_NOT_FRESH") {
    return new SessionNotFreshError(message);
  }
  return new Error(message);
}

/**
 * Thrown by `login()` when the credentials are right but the address was never
 * verified. Better Auth has just emailed a fresh verification link, so the
 * caller sends the user to the "check your inbox" screen instead of showing
 * the raw refusal.
 */
export class EmailNotVerifiedError extends Error {}

/** Map a raw Better Auth sign-in error into the SPA error type. */
export function toLoginError(error: { code?: string | null; message?: string | null }): Error {
  const message = error.message ?? "";
  if (error.code === "EMAIL_NOT_VERIFIED") {
    return new EmailNotVerifiedError(message);
  }
  return new Error(message);
}

/**
 * Error codes Better Auth appends (`?error=`) to the verification link's
 * callback URL when the link cannot be honoured.
 */
const VERIFICATION_LINK_ERRORS = new Set([
  "INVALID_TOKEN",
  "TOKEN_EXPIRED",
  "USER_NOT_FOUND",
  "INVALID_USER",
]);

/** Whether a location's query string reports a failed verification link. */
export function hasVerificationLinkError(search: string): boolean {
  const error = new URLSearchParams(search).get("error");
  return error !== null && VERIFICATION_LINK_ERRORS.has(error);
}
