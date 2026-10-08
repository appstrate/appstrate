// SPDX-License-Identifier: Apache-2.0

import { ApiError } from "../api/errors";

/**
 * A refused reset whose password was nonetheless written: the link is spent,
 * so the way to finish signing the other devices out is a new reset link.
 */
export function resetFailure(err: unknown): "revocation_failed" | "invalid_token" {
  return err instanceof ApiError && err.code === "credential_change_revocation_failed"
    ? "revocation_failed"
    : "invalid_token";
}
