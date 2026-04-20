// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import { runCli } from "../../src/cli/index.ts";
import { captureIo } from "./helpers.ts";

describe("afps conformance", () => {
  it("runs all built-in cases and exits 0 when they pass", async () => {
    const io = captureIo();
    const code = await runCli(["conformance"], io);
    expect(code).toBe(0);
    const text = io.stdoutText();
    expect(text).toContain("@appstrate/afps-runtime");
    expect(text).toContain("[L1.1]");
    expect(text).toContain("[L3.5]");
    expect(text).toContain("Summary: 15/15 passed");
  });

  it("emits JSON under --json", async () => {
    const io = captureIo();
    const code = await runCli(["conformance", "--json"], io);
    expect(code).toBe(0);
    const report = JSON.parse(io.stdoutText());
    expect(report.adapter).toBe("@appstrate/afps-runtime");
    expect(report.summary.total).toBe(15);
    expect(report.summary.failed).toBe(0);
  });

  it("narrows to a single level via --levels", async () => {
    const io = captureIo();
    const code = await runCli(["conformance", "--levels", "L1", "--json"], io);
    expect(code).toBe(0);
    const report = JSON.parse(io.stdoutText());
    expect(new Set(report.cases.map((c: { level: string }) => c.level))).toEqual(new Set(["L1"]));
  });

  it("narrows to specific case ids via --only", async () => {
    const io = captureIo();
    const code = await runCli(["conformance", "--only", "L3.1,L3.4", "--json"], io);
    expect(code).toBe(0);
    const report = JSON.parse(io.stdoutText());
    expect(report.cases.map((c: { id: string }) => c.id).sort()).toEqual(["L3.1", "L3.4"]);
  });

  it("returns exit 2 for an unknown level", async () => {
    const io = captureIo();
    const code = await runCli(["conformance", "--levels", "L9"], io);
    expect(code).toBe(2);
    expect(io.stderrText()).toContain("unknown level 'L9'");
  });
});
