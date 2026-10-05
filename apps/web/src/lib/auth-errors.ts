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
