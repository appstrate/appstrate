// SPDX-License-Identifier: Apache-2.0

/**
 * In-memory `CommandIO` for CLI command tests.
 *
 * Replaces the `captureIo()` pattern that reassigned the *global*
 * `process.stdout.write` / `process.stderr.write` / `process.exit`. Because
 * `bun test` runs every package in one process, those buffers collected any
 * concurrent write in the repo and made `toBe("")` a coin flip — issue #1180.
 *
 * **What the buffer guarantees.** It is unshared and deterministic: only what
 * the code under test writes *through this `io` object* can ever reach it. No
 * other suite, no library, and not the runner itself holds a reference, so a
 * failing assertion here always indicts the command it names. That is the
 * whole of the guarantee — it is about *provenance*, not about which of the
 * command's own writes end up in there.
 *
 * `exit` throws `CommandExit`, exactly as production `DEFAULT_IO` does, so
 * `await expect(cmd(...)).rejects.toBeInstanceOf(CommandExit)` unwinds the
 * command along the same path production takes, and the code stays
 * assertable on the error.
 */

import { CommandExit, type CommandIO } from "../../src/lib/io.ts";

/**
 * Not exported on purpose: knip fails the build on a type nothing imports,
 * and `ReturnType<typeof createMemoryIO>` covers the rare caller that needs
 * to name this shape.
 */
interface MemoryIO {
  io: CommandIO;
  /** Everything written to stdout, plus anything rendered through `cancel`. */
  stdout(): string;
  /** Everything written to stderr, in write order. */
  stderr(): string;
}

export function createMemoryIO(): MemoryIO {
  const out: string[] = [];
  const err: string[] = [];
  const decoder = new TextDecoder();
  const text = (chunk: string | Uint8Array): string =>
    typeof chunk === "string" ? chunk : decoder.decode(chunk);

  return {
    io: {
      stdout: {
        write(chunk) {
          out.push(text(chunk));
        },
      },
      stderr: {
        write(chunk) {
          err.push(text(chunk));
        },
      },
      exit: (code) => {
        throw new CommandExit(code);
      },
      // Production renders terminal errors with `clack.cancel`, which writes
      // to *stdout*. This sink keeps that channel and drops only the ANSI
      // framing, so assertions read plain text on the stream the user really
      // sees. Routing it to stderr instead (as this helper first did) made
      // `expect(stdout()).toBe("")` pass on error paths where production
      // prints the error on stdout — a green assertion about the wrong stream.
      cancel: (message) => {
        out.push(`${message}\n`);
      },
    },
    stdout: () => out.join(""),
    stderr: () => err.join(""),
  };
}
