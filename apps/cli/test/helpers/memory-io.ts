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
 * `exit` throws the shared `ExitError` from `process-exit.ts`, so the usual
 * `await expect(cmd(...)).rejects.toBeInstanceOf(ExitError)` unwind still
 * works and the exit code is still assertable.
 *
 * **Caveat: the exit unwind can add a line of its own.** Eight call sites (at
 * the time of writing) invoke `io.exit(...)` from *inside* a `try` whose
 * `catch` also handles errors — `src/commands/token.ts:57`, caught at `:114`,
 * is the canonical shape. Under production `DEFAULT_IO` that `exit` never
 * returns (the process is gone), so the `catch` is unreachable. Under this
 * sink `exit` throws instead, and the command's own `catch` treats the
 * `ExitError` like any other failure: it runs it through `formatError`, which
 * falls through to `err.message` — for `ExitError` the literal string
 * `"process.exit(<code>) called"` — and writes it out before exiting a second
 * time. The line lands in whichever buffer that `catch` renders to: stderr
 * when it writes `formatError(err)` itself (token.ts:115), stdout when it
 * delegates to `exitWithError`, which goes through `cancel` (see below).
 *
 * That extra line is deterministic, not cross-suite pollution, and it is
 * inherent to intercepting `exit` at all — the retired `captureIo()` produced
 * it too. Fixing it would mean either restructuring eight `catch` blocks or
 * teaching `src/` about a test-only error class, so it stays. The consequence
 * for test authors: on those exit-inside-try branches assert with
 * `toContain(...)`, never `toBe(...)`. Tightening one of them to an exact
 * match will fail on a trailing `"process.exit(1) called\n"` that the command
 * did not write.
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
        throw new ExitError(code);
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
