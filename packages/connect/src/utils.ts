// SPDX-License-Identifier: Apache-2.0

/**
 * Shared utilities for the connect package.
 */

import { getErrorMessage } from "@appstrate/core/errors";

/**
 * Extract a human-readable error message from an unknown error value.
 * Thin alias over `@appstrate/core`'s `getErrorMessage` (kept for the
 * connect-package call sites).
 */
export function extractErrorMessage(err: unknown): string {
  return getErrorMessage(err);
}
