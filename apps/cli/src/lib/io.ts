// SPDX-License-Identifier: Apache-2.0

/**
 * Injectable stdout / stderr / exit seam.
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
 * **How far it actually reaches.** A command takes it as a trailing
 * `io: CommandIO = DEFAULT_IO` parameter (`commands/org.ts` is the reference
 * shape), and the `lib/ui.ts` wrappers each forward one. Twelve of the sixteen
 * modules in `commands/*.ts` do; four deliberately do not, and the seam is not
 * a claim about them:
 *
 *   - `commands/run.ts` owns a *different* output architecture.
 *     `attachStdoutBridge` reassigns the process-global
 *     `process.stdout.write` on purpose — that is how canonical tool events
 *     emitted as JSON lines get aspirated — and the sinks take explicit
 *     `writeStdout` / `writeStderr` writers so their own emissions can bypass
 *     that interceptor via the bridge's `writeRaw` (see the docstring in
 *     `commands/run/sink.ts`). A `CommandIO` layered on top would be a second
 *     seam over the same bytes, not a unification. Its `commands/run/*`
 *     helpers are not covered by that reasoning one way or the other:
 *     `run/input.ts` takes an optional `io?: CommandIO` because
 *     `validateLocalInput` exits the process and a test asserting that needs
 *     its own sink.
 *   - `commands/runner.ts` and `commands/lifecycle.ts` are host-level
 *     installers whose user-visible output already goes through `lib/ui.ts`;
 *     nothing injects a sink into them today, so they are reachable the day a
 *     test needs one but are not pre-threaded.
 *   - `commands/install.ts` is the same case, plus its own older prompt-DI
 *     seams (`deps.select` / `deps.note` / `deps.warn`).
 *
 * `ApiCommandIO` (`src/commands/api/types.ts`) is the one true extension: it
 * adds `onSigint` / `stdinStream` on top of `CommandIO` and spreads
 * `DEFAULT_IO` rather than re-implementing it. The `writeStdout` option of
 * `commands/run/sink.ts` is NOT an instance of this seam and was never
 * migrated onto it — `sink.ts` and `commands/run/remote-runner.ts` each still
 * declare their own writer pair, for the bridge reason above.
 *
 * Four members, deliberately — no colour, TTY or logger abstraction. A
 * command that needs more than "write bytes, exit" keeps that logic in the
 * command; widening the seam would put it in everyone's way. (The one TTY
 * decision the CLI does make — repaint or plain lines — lives in
 * `lib/ui.ts`'s `spinner`, which reads `process.stdout.isTTY` directly.)
 */

import * as clack from "@clack/prompts";

export interface CommandIO {
  stdout: { write(chunk: string | Uint8Array): void };
  stderr: { write(chunk: string | Uint8Array): void };
  /** Hook so tests assert exit codes without terminating the runner. */
  exit: (code: number) => never;
  /**
   * Terminal-error renderer. Production uses `clack.cancel` so the message
   * keeps its styled treatment; a test sink supplies a plain writer on the
   * same channel. Required, not optional: every sink in the CLI supplies one,
   * so an optional member would only buy `exitWithError` a fallback branch
   * that nothing but its own test could reach.
   */
  cancel: (message: string) => void;
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
