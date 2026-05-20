// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Contract tests for the built-in runtime tool factory selector.
 *
 * The five former system-tool packages (output/log/note/pin/report) are
 * now baked into the runner after the `tool` AFPS package type was removed.
 * `selectBuiltinRuntimeToolFactories(runtimeTools)` resolves an agent
 * manifest's `runtimeTools: string[]` selection into the concrete factory
 * set the runner registers with the Pi SDK:
 *   - `output` is MANDATORY — always included regardless of selection.
 *   - log/note/pin/report are opt-in via the selection.
 *   - unknown ids are ignored (install-time validation rejects them upstream).
 */

import { describe, it, expect } from "bun:test";
import {
  BUILTIN_RUNTIME_TOOL_FACTORIES,
  MANDATORY_RUNTIME_TOOLS,
  SELECTABLE_RUNTIME_TOOLS,
  selectBuiltinRuntimeToolFactories,
} from "../src/runtime-tools/builtin/index.ts";

function selectedIds(runtimeTools: readonly string[] | undefined): string[] {
  return selectBuiltinRuntimeToolFactories(runtimeTools).map((e) => e.id);
}

describe("selectBuiltinRuntimeToolFactories", () => {
  it("yields only `output` when the selection is undefined", () => {
    expect(selectedIds(undefined)).toEqual(["output"]);
  });

  it("yields only `output` when the selection is empty", () => {
    expect(selectedIds([])).toEqual(["output"]);
  });

  it("always includes the mandatory `output` alongside the selection", () => {
    const ids = selectedIds(["log", "note"]);
    expect(ids).toContain("output");
    expect(ids).toContain("log");
    expect(ids).toContain("note");
    expect(ids.sort()).toEqual(["log", "note", "output"]);
  });

  it("never duplicates `output` even if the selection lists it", () => {
    const ids = selectedIds(["output", "log"]);
    expect(ids.filter((id) => id === "output")).toHaveLength(1);
    expect(ids.sort()).toEqual(["log", "output"]);
  });

  it("ignores unknown ids (validation rejects them upstream)", () => {
    expect(selectedIds(["log", "totally-unknown", "report"]).sort()).toEqual([
      "log",
      "output",
      "report",
    ]);
  });

  it("can resolve the full selectable set + mandatory", () => {
    const ids = selectedIds([...SELECTABLE_RUNTIME_TOOLS]).sort();
    expect(ids).toEqual([...MANDATORY_RUNTIME_TOOLS, ...SELECTABLE_RUNTIME_TOOLS].sort());
  });

  it("returns a concrete factory function for every resolved entry", () => {
    for (const { factory } of selectBuiltinRuntimeToolFactories([...SELECTABLE_RUNTIME_TOOLS])) {
      expect(typeof factory).toBe("function");
    }
  });
});

describe("BUILTIN_RUNTIME_TOOL_FACTORIES", () => {
  it("keys === [output, ...SELECTABLE_RUNTIME_TOOLS]", () => {
    expect(Object.keys(BUILTIN_RUNTIME_TOOL_FACTORIES)).toEqual([
      ...MANDATORY_RUNTIME_TOOLS,
      ...SELECTABLE_RUNTIME_TOOLS,
    ]);
  });

  it("every value is a factory function", () => {
    for (const factory of Object.values(BUILTIN_RUNTIME_TOOL_FACTORIES)) {
      expect(typeof factory).toBe("function");
    }
  });

  it("local SELECTABLE list matches the documented catalog set", () => {
    // Drift guard: this list is duplicated from
    // `@appstrate/core/runtime-tools-catalog` so the published runner
    // package stays dependency-light. The core-side mirror test asserts
    // the same literal — keep both in sync.
    expect([...SELECTABLE_RUNTIME_TOOLS]).toEqual(["log", "note", "pin", "report"]);
    expect([...MANDATORY_RUNTIME_TOOLS]).toEqual(["output"]);
  });
});
