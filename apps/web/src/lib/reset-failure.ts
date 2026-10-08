// SPDX-License-Identifier: Apache-2.0

import { ApiError } from "../api/errors";

/** A refused password change or reset whose new password was nonetheless written. */
export function isRevocationFailure(err: unknown): boolean {
  return err instanceof ApiError && err.code === "credential_change_revocation_failed";
}

/**
 * A refused reset whose password was nonetheless written: the link is spent,
 * so the way to finish signing the other devices out is a new reset link.
 */
export function resetFailure(err: unknown): "revocation_failed" | "invalid_token" {
  return isRevocationFailure(err) ? "revocation_failed" : "invalid_token";
}
