// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import { runCli } from "../../src/cli/index.ts";
import { captureIo } from "./helpers.ts";

describe("runCli — dispatch", () => {
  it("prints help text with no arguments", async () => {
    const io = captureIo();
    const code = await runCli([], io);
    expect(code).toBe(0);
    expect(io.stdoutText()).toContain("afps — AFPS bundle tooling");
    expect(io.stdoutText()).toContain("Commands:");
  });

  it("accepts --help, -h, and 'help'", async () => {
    for (const flag of ["--help", "-h", "help"]) {
      const io = captureIo();
      const code = await runCli([flag], io);
      expect(code).toBe(0);
      expect(io.stdoutText()).toContain("Usage:");
    }
  });

  it("returns exit 2 for unknown commands", async () => {
    const io = captureIo();
    const code = await runCli(["walk-the-dog"], io);
    expect(code).toBe(2);
    expect(io.stderrText()).toContain("unknown command");
  });

  it("rejects the removed 'run' subcommand (live LLM execution lives in apps/cli)", async () => {
    const io = captureIo();
    const code = await runCli(["run", "any.afps"], io);
    expect(code).toBe(2);
    expect(io.stderrText()).toContain("unknown command 'run'");
  });

  it("rejects the removed 'test' subcommand (scripted replay via library API now)", async () => {
    const io = captureIo();
    const code = await runCli(["test", "any.afps"], io);
    expect(code).toBe(2);
    expect(io.stderrText()).toContain("unknown command 'test'");
  });

  it("help text advertises neither 'run' nor 'test' and points at appstrate run", async () => {
    const io = captureIo();
    await runCli([], io);
    const help = io.stdoutText();
    expect(help).not.toMatch(/^\s*run\s+</m);
    expect(help).not.toMatch(/^\s*test\s+</m);
    expect(help).toContain("appstrate run");
  });

  it("converts thrown subcommand errors into a single-line stderr diagnostic + exit 1", async () => {
    const io = captureIo();
    // inspect on a non-existent path triggers ENOENT from readFile.
    const code = await runCli(["inspect", "/definitely-not-a-real-path.afps"], io);
    expect(code).toBe(1);
    expect(io.stderrText()).toContain("afps inspect:");
    expect(io.stderrText()).toContain("ENOENT");
    // Must not leak a multi-line Bun stack trace.
    expect(
      io
        .stderrText()
        .split("\n")
        .filter((l) => l.length > 0),
    ).toHaveLength(1);
  });
});
