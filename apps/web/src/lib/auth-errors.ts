// SPDX-License-Identifier: Apache-2.0

import { ApiError } from "../api/errors";

/** `SESSION_NOT_FRESH` from a fresh-gated action. Match via `instanceof`, never the (localizable) message. */
export class SessionNotFreshError extends Error {}

interface BetterAuthError {
  code?: string | null;
  message?: string | null;
  status?: number;
}

/** So the `code` is translated like any refusal (`errorMessage`), not the English `message`. */
export function toAuthError(error: BetterAuthError): ApiError {
  return new ApiError(error.code ?? "", error.message ?? "", error.status ?? 0);
}

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
