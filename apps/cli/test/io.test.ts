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
import type { CommandIO } from "../src/lib/io.ts";
import { exitWithError } from "../src/lib/ui.ts";
import { createMemoryIO } from "./helpers/memory-io.ts";
import { ExitError } from "./helpers/process-exit.ts";
import { runIsolated } from "./helpers/isolated-process.ts";

const IO_MODULE = JSON.stringify(`${import.meta.dir}/../src/lib/io.ts`);
const UI_MODULE = JSON.stringify(`${import.meta.dir}/../src/lib/ui.ts`);

describe("DEFAULT_IO", () => {
  it("writes to the real process streams and exits with the given code", async () => {
    const { stdout, stderr, exitCode } = await runIsolated(`
      const { DEFAULT_IO } = await import(${IO_MODULE});
      DEFAULT_IO.stdout.write("to-stdout");
      DEFAULT_IO.stderr.write("to-stderr");
      DEFAULT_IO.stdout.write(new TextEncoder().encode("-bytes"));
      DEFAULT_IO.exit(3);
    `);
    expect(stdout).toBe("to-stdout-bytes");
    expect(stderr).toBe("to-stderr");
    expect(exitCode).toBe(3);
  });

  it("renders errors byte-for-byte as `clack.cancel` did before the seam", async () => {
    // The guard on the "flake fix, not a UX change" constraint: the default
    // path must keep clack's styling *and* its stdout destination.
    const [before, after] = await Promise.all([
      runIsolated(`
        const clack = await import("@clack/prompts");
        clack.cancel("boom");
      `),
      runIsolated(`
        const { exitWithError } = await import(${UI_MODULE});
        exitWithError(new Error("boom"));
      `),
    ]);
    expect(after.stdout).toBe(before.stdout);
    expect(after.stderr).toBe("");
    expect(after.exitCode).toBe(1);
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

  it("throws ExitError carrying the code instead of terminating the runner", () => {
    const { io } = createMemoryIO();
    expect(() => io.exit(7)).toThrow(ExitError);
    try {
      io.exit(7);
    } catch (err) {
      expect(err).toBeInstanceOf(ExitError);
      expect((err as ExitError).code).toBe(7);
    }
  });
});

describe("exitWithError", () => {
  it("routes the formatted message to the injected io and exits with the code", () => {
    const { io, stdout, stderr } = createMemoryIO();
    expect(() => exitWithError(new Error("nope"), io, 4)).toThrow(ExitError);
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
      expect(err).toBeInstanceOf(ExitError);
      expect((err as ExitError).code).toBe(1);
    }
  });

  it("renders through `cancel` when the io supplies one", () => {
    const rendered: string[] = [];
    const io: CommandIO = {
      stdout: { write: () => {} },
      stderr: {
        write: () => {
          throw new Error("stderr must not be used when cancel is present");
        },
      },
      exit: (code) => {
        throw new ExitError(code);
      },
      cancel: (message) => {
        rendered.push(message);
      },
    };
    expect(() => exitWithError(new Error("styled"), io)).toThrow(ExitError);
    // `cancel` owns its own framing, so the message arrives without a newline.
    expect(rendered).toEqual(["styled"]);
  });

  it("falls back to stderr when the io supplies no `cancel`", () => {
    const chunks: string[] = [];
    const io: CommandIO = {
      stdout: {
        write: () => {
          throw new Error("errors must not reach stdout on the fallback path");
        },
      },
      stderr: { write: (chunk) => void chunks.push(String(chunk)) },
      exit: (code) => {
        throw new ExitError(code);
      },
    };
    expect(() => exitWithError(new Error("plain"), io)).toThrow(ExitError);
    expect(chunks.join("")).toBe("plain\n");
  });

  it("applies `formatError` before handing the message to the io", () => {
    const { io, stdout } = createMemoryIO();
    const err = Object.assign(new Error("bad input"), { hint: "pass --force" });
    expect(() => exitWithError(err, io)).toThrow(ExitError);
    expect(stdout()).toBe("bad input — pass --force\n");
  });
});
