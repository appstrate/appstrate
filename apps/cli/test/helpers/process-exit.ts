// SPDX-License-Identifier: Apache-2.0

/**
 * The error a test-owned `CommandIO.exit` throws instead of terminating the
 * runner.
 *
 * CLI commands end error branches (and some success ones) with
 * `io.exit(code)`. Under production `DEFAULT_IO` that is `process.exit` and
 * never returns. Under `createMemoryIO()` (`./memory-io.ts`) it throws this
 * instead, so a test can assert the code AND unwind the call stack cleanly:
 *
 *     await expect(cmd(opts, io)).rejects.toBeInstanceOf(ExitError);
 *
 * It lives in its own file because `memory-io.ts` produces it and every
 * command suite consumes it — one class, one identity, so `instanceof` holds
 * across the suite.
 *
 * **No CLI test rebinds `process.exit` any more.** That pattern — a local
 * `Error` subclass plus a re-bound global — is the one issue #1180 retired,
 * and `eslint.config.mjs` now refuses it under every `test/` directory, along
 * with assignments to `process.stdout.write` / `process.stderr.write`. `bun test`
 * runs every package in one process, so a global swapped for the duration of
 * one call is a global swapped for whatever else is running concurrently.
 * Inject a sink the test owns instead.
 */
export class ExitError extends Error {
  constructor(public readonly code: number) {
    super(`process.exit(${code}) called`);
  }
}
