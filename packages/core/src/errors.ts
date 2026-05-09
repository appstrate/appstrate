// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/** Application error with a machine-readable error code. */
export class AppError extends Error {
  /**
   * @param code - Machine-readable error code (e.g. "NOT_FOUND", "UNAUTHORIZED")
   * @param message - Human-readable error description
   */
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

/**
 * Create a function that maps error codes to HTTP status codes.
 * Unknown codes default to 500.
 * @param map - Mapping of error codes to HTTP status codes
 * @returns A function that resolves an error code to its HTTP status
 */
export function createErrorStatusMap(map: Record<string, number>): (code: string) => number {
  return (code: string): number => map[code] ?? 500;
}

/**
 * Extract a string message from an unknown error.
 * Use at boundaries where errors are caught and surfaced to humans/logs.
 * @param err - The unknown error value (typically from a catch block)
 * @returns The error's `message` if it's an Error instance, otherwise `String(err)`
 */
export function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
