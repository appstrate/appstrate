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
