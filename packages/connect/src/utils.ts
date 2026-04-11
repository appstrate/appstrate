// SPDX-License-Identifier: Apache-2.0

/**
 * Shared utilities for the connect package.
 */

/**
 * Extract a human-readable error message from an unknown error value.
 */
export function extractErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
