// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the `CommandIO` seam (`src/lib/io.ts`) and the
 * `exitWithError` renderer that consumes it — issue #1180.
 *
 * These tests deliberately never assign to `process.stdout.write`,
 * `process.stderr.write` or `process.exit`: that is the very pattern the seam
 * exists to retire, and doing it here would reintroduce the cross-suite
 * capture flake inside the test that is supposed to prove it gone. Where the
 * real streams have to be observed — `DEFAULT_IO` writes to them by
 * definition — a child `bun` process owns them, so the assertion is about a
 * buffer this test alone can write to.
 */

import { describe, it, expect } from "bun:test";
import { CommandExit, DEFAULT_IO, type CommandIO } from "../src/lib/io.ts";
import { exitWithError } from "../src/lib/ui.ts";
import { createMemoryIO } from "./helpers/memory-io.ts";
import { runIsolated } from "./helpers/isolated-process.ts";

const IO_MODULE = JSON.stringify(`${import.meta.dir}/../src/lib/io.ts`);
const UI_MODULE = JSON.stringify(`${import.meta.dir}/../src/lib/ui.ts`);

describe("DEFAULT_IO", () => {
  it("writes to the real process streams and exits with the given code", async () => {
    const { stdout, stderr, exitCode } = await runIsolated(`
      const { DEFAULT_IO } = await import(${IO_MODULE});
      const { settleCommand } = await import(${UI_MODULE});
      DEFAULT_IO.stdout.write("to-stdout");
      DEFAULT_IO.stderr.write("to-stderr");
      DEFAULT_IO.stdout.write(new TextEncoder().encode("-bytes"));
      try {
        DEFAULT_IO.exit(3);
      } catch (err) {
        settleCommand(err);
      }
    `);
    expect(stdout).toBe("to-stdout-bytes");
    expect(stderr).toBe("to-stderr");
    expect(exitCode).toBe(3);
  });

  it("exits by throwing CommandExit, so nothing after it runs", () => {
    let after = false;
    try {
      DEFAULT_IO.exit(4);
      after = true;
    } catch (err) {
      expect(err).toBeInstanceOf(CommandExit);
      expect((err as CommandExit).code).toBe(4);
    }
    expect(after).toBe(false);
  });

  it("renders errors byte-for-byte as `clack.cancel` did before the seam", async () => {
    // The guard on the "flake fix, not a UX change" constraint: the default
    // path must keep clack's styling *and* its stdout destination.
    const [before, after, settled] = await Promise.all([
      runIsolated(`
        const clack = await import("@clack/prompts");
        clack.cancel("boom");
      `),
      runIsolated(`
        const { exitWithError, settleCommand } = await import(${UI_MODULE});
        try {
          exitWithError(new Error("boom"));
        } catch (err) {
          settleCommand(err);
        }
      `),
      // An error no command rendered reaches `cli.ts`'s handler as-is.
      runIsolated(`
        const { settleCommand } = await import(${UI_MODULE});
        settleCommand(new Error("boom"));
      `),
    ]);
    for (const run of [after, settled]) {
      expect(run.stdout).toBe(before.stdout);
      expect(run.stderr).toBe("");
      expect(run.exitCode).toBe(1);
    }
  });
});

describe("createMemoryIO", () => {
  it("keeps stdout and stderr in separate buffers", () => {
    const { io, stdout, stderr } = createMemoryIO();
    io.stdout.write("one");
    io.stderr.write("two");
    io.stdout.write("three");
    expect(stdout()).toBe("onethree");
    expect(stderr()).toBe("two");
  });

  it("decodes byte chunks so assertions read as text", () => {
    const { io, stdout } = createMemoryIO();
    io.stdout.write(new TextEncoder().encode("héllo"));
    expect(stdout()).toBe("héllo");
  });

  it('starts empty, so `toBe("")` states something about this test only', () => {
    const { stdout, stderr } = createMemoryIO();
    expect(stdout()).toBe("");
    expect(stderr()).toBe("");
  });

  it("throws CommandExit carrying the code instead of terminating the runner", () => {
    const { io } = createMemoryIO();
    expect(() => io.exit(7)).toThrow(CommandExit);
    try {
      io.exit(7);
    } catch (err) {
      expect(err).toBeInstanceOf(CommandExit);
      expect((err as CommandExit).code).toBe(7);
    }
  });
});

describe("exitWithError", () => {
  it("routes the formatted message to the injected io and exits with the code", () => {
    const { io, stdout, stderr } = createMemoryIO();
    expect(() => exitWithError(new Error("nope"), io, 4)).toThrow(CommandExit);
    // `createMemoryIO` renders through `cancel`, and production `cancel` is
    // `clack.cancel` — a stdout writer. The sink keeps that channel.
    expect(stdout()).toBe("nope\n");
    expect(stderr()).toBe("");
  });

  it("defaults to exit code 1", () => {
    const { io } = createMemoryIO();
    try {
      exitWithError(new Error("nope"), io);
      throw new Error("expected exitWithError to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CommandExit);
      expect((err as CommandExit).code).toBe(1);
    }
  });

  it("routes the message through `cancel`, never through stderr", () => {
    const rendered: string[] = [];
    const io: CommandIO = {
      stdout: { write: () => {} },
      stderr: {
        write: () => {
          throw new Error("stderr must not be used when cancel is present");
        },
      },
      exit: (code) => {
        throw new CommandExit(code);
      },
      cancel: (message) => {
        rendered.push(message);
      },
    };
    expect(() => exitWithError(new Error("styled"), io)).toThrow(CommandExit);
    // `cancel` owns its own framing, so the message arrives without a newline.
    expect(rendered).toEqual(["styled"]);
  });

  it("passes a CommandExit through unrendered", () => {
    const { io, stdout } = createMemoryIO();
    const exit = new CommandExit(3);
    expect(() => exitWithError(exit, io)).toThrow(exit);
    expect(stdout()).toBe("");
  });

  it("applies `formatError` before handing the message to the io", () => {
    const { io, stdout } = createMemoryIO();
    const err = Object.assign(new Error("bad input"), { hint: "pass --force" });
    expect(() => exitWithError(err, io)).toThrow(CommandExit);
    expect(stdout()).toBe("bad input — pass --force\n");
  });
});
