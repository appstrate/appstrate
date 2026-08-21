// SPDX-License-Identifier: Apache-2.0

/**
 * In-memory `CommandIO` for CLI command tests.
 *
 * Replaces the `captureIo()` pattern that reassigned the *global*
 * `process.stdout.write` / `process.stderr.write` / `process.exit`. Because
 * `bun test` runs every package in one process, those buffers collected any
 * concurrent write in the repo and made `toBe("")` a coin flip — issue #1180.
 * A sink created here belongs to exactly one test, so its contents are
 * evidence about the command under test and nothing else.
 *
 * `exit` throws the shared `ExitError` from `process-exit.ts`, so the usual
 * `await expect(cmd(...)).rejects.toBeInstanceOf(ExitError)` unwind still
 * works and the exit code is still assertable.
 */

import type { CommandIO } from "../../src/lib/io.ts";
import { ExitError } from "./process-exit.ts";

/**
 * Not exported on purpose: knip fails the build on a type nothing imports,
 * and `ReturnType<typeof createMemoryIO>` covers the rare caller that needs
 * to name this shape.
 */
interface MemoryIO {
  io: CommandIO;
  /** Everything written to stdout, in write order. */
  stdout(): string;
  /** Everything written to stderr, plus anything rendered through `cancel`. */
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
        throw new ExitError(code);
      },
      // Production renders terminal errors with `clack.cancel` (styled, on
      // stdout). Tests want the plain message in a predictable place, so it
      // lands on stderr — assertions read the text, never the ANSI framing.
      cancel: (message) => {
        err.push(`${message}\n`);
      },
    },
    stdout: () => out.join(""),
    stderr: () => err.join(""),
  };
}
