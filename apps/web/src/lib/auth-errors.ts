// SPDX-License-Identifier: Apache-2.0

import { ApiError } from "../api/errors";

/**
 * Thrown by `unlinkAccount()` (and any other fresh-gated action) when Better
 * Auth rejects the request with `SESSION_NOT_FRESH`. Callers catch this
 * discriminant (via `instanceof`, never message sniffing — the BA message is
 * localizable/unstable) to walk the user through a step-up re-login instead of
 * surfacing a raw error.
 */
export class SessionNotFreshError extends Error {}

interface BetterAuthError {
  code?: string | null;
  message?: string | null;
  status?: number;
}

/**
 * A Better Auth failure as the SPA's `ApiError`, so its `code` is translated like any other
 * refusal (`errorMessage`) instead of its English `message` reaching the form.
 */
export function toAuthError(error: BetterAuthError): ApiError {
  return new ApiError(error.code ?? "", error.message ?? "", error.status ?? 0);
}

/**
 * Map a raw Better Auth error into the SPA error type. Isolated as a pure
 * function so the mapping is unit-testable without a rendering harness.
 */
export function toUnlinkError(error: BetterAuthError): Error {
  if (error.code === "SESSION_NOT_FRESH") {
    return new SessionNotFreshError(error.message ?? "");
  }
  return toAuthError(error);
}

/** Thrown by `login()`: right credentials, unverified address. Better Auth has just re-sent the link. */
export class EmailNotVerifiedError extends Error {}

export function toLoginError(error: BetterAuthError): Error {
  if (error.code === "EMAIL_NOT_VERIFIED") {
    return new EmailNotVerifiedError(error.message ?? "");
  }
  return toAuthError(error);
}

/** Codes Better Auth appends (`?error=`) to a verification link's callback URL. */
const VERIFICATION_LINK_ERRORS = new Set([
  "INVALID_TOKEN",
  "TOKEN_EXPIRED",
  "USER_NOT_FOUND",
  "INVALID_USER",
]);

export function hasVerificationLinkError(search: string): boolean {
  const error = new URLSearchParams(search).get("error");
  return error !== null && VERIFICATION_LINK_ERRORS.has(error);
}
