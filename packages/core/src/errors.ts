// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * Extract a string message from an unknown error.
 * Use at boundaries where errors are caught and surfaced to humans/logs.
 * @param err - The unknown error value (typically from a catch block)
 * @returns The error's `message` if it's an Error instance, otherwise `String(err)`
 */
export function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
