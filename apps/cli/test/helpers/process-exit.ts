// SPDX-License-Identifier: Apache-2.0

/**
 * Shared `process.exit` shim for CLI command tests.
 *
 * CLI commands call `process.exit(code)` on error branches (and sometimes
 * after writing the success message via `io.exit(0)`). Tests need to
 * intercept those exits to:
 *   1. assert the exit code without killing the test worker
 *   2. unwind the call stack cleanly via `await expect(...).rejects.toBeInstanceOf(ExitError)`
 *
 * Each test that monkey-patches `process.exit` does it the same way:
 * a tiny `Error` subclass carrying the code, and a re-bound `process.exit`
 * that throws it. Six test files used to declare identical copies; this
 * helper is the single source of truth.
 */
export class ExitError extends Error {
  constructor(public readonly code: number) {
    super(`process.exit(${code}) called`);
  }
}
