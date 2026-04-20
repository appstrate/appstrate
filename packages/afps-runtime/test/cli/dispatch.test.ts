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
});
