// SPDX-License-Identifier: Apache-2.0

/**
 * Injectable stdout / stderr / exit seam, shared by every command.
 *
 * **The flake it prevents (issue #1180).** `bun test` runs the whole repo in
 * a single process, so a suite that swaps the *global* `process.stdout.write`
 * to capture a command's output also captures whatever any other suite, any
 * library, or the runner itself happens to write during that window. An
 * `expect(captured).toBe("")` written that way is an assertion about a buffer
 * the test does not own: it fails non-deterministically, and it names an
 * innocent command when it does. Handing each command its own sink removes
 * the shared mutable state instead of trying to time around it.
 *
 * This generalises two seams that already existed in this CLI:
 * `ApiCommandIO` in `src/commands/api/types.ts` (now an extension of
 * `CommandIO`) and the `writeStdout` option of `src/commands/run/sink.ts`.
 *
 * Four members, deliberately — no colour, TTY or logger abstraction. A
 * command that needs more than "write bytes, exit" keeps that logic in the
 * command; widening the seam would put it in everyone's way.
 */

import * as clack from "@clack/prompts";

export interface CommandIO {
  stdout: { write(chunk: string | Uint8Array): void };
  stderr: { write(chunk: string | Uint8Array): void };
  /** Hook so tests assert exit codes without terminating the runner. */
  exit: (code: number) => never;
  /**
   * Optional terminal-error renderer. Production uses `clack.cancel` so the
   * message keeps its styled treatment; tests supply a plain sink. When
   * absent, `exitWithError` falls back to `stderr.write`.
   */
  cancel?: (message: string) => void;
}

/**
 * Production wiring — what every command gets when the caller injects
 * nothing.
 *
 * `cancel` is wired here rather than in `ui.ts` so the dependency arrow stays
 * one-way (`ui.ts` → `io.ts`, never the reverse). `@clack/prompts` is an
 * external leaf, so importing it from this module cannot close a cycle, and
 * `exitWithError` needs no special case for its own default.
 */
export const DEFAULT_IO: CommandIO = {
  stdout: {
    write(chunk) {
      process.stdout.write(chunk);
    },
  },
  stderr: {
    write(chunk) {
      process.stderr.write(chunk);
    },
  },
  exit: (code) => process.exit(code),
  // Wrapped rather than passed by reference so the seam pins the one-argument
  // form regardless of what else clack's export carries.
  cancel: (message) => {
    clack.cancel(message);
  },
};
