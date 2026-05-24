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
 *   - every tool is opt-in (output included) — nothing is auto-injected.
 *   - unknown ids are ignored (install-time validation rejects them upstream).
 */

import { describe, it, expect } from "bun:test";
import {
  BUILTIN_RUNTIME_TOOL_FACTORIES,
  SELECTABLE_RUNTIME_TOOLS,
  selectBuiltinRuntimeToolFactories,
} from "../src/runtime-tools/builtin/index.ts";

function selectedIds(runtimeTools: readonly string[] | undefined): string[] {
  return selectBuiltinRuntimeToolFactories(runtimeTools).map((e) => e.id);
}

describe("selectBuiltinRuntimeToolFactories", () => {
  it("yields nothing when the selection is undefined", () => {
    expect(selectedIds(undefined)).toEqual([]);
  });

  it("yields nothing when the selection is empty", () => {
    expect(selectedIds([])).toEqual([]);
  });

  it("includes `output` only when it is selected", () => {
    expect(selectedIds(["output"])).toEqual(["output"]);
    expect(selectedIds(["log", "note"])).not.toContain("output");
  });

  it("resolves exactly the selected tools", () => {
    const ids = selectedIds(["output", "log", "note"]);
    expect(ids.sort()).toEqual(["log", "note", "output"]);
  });

  it("never duplicates a tool even if the selection repeats it", () => {
    const ids = selectedIds(["output", "output", "log"]);
    expect(ids.filter((id) => id === "output")).toHaveLength(1);
    expect(ids.sort()).toEqual(["log", "output"]);
  });

  it("ignores unknown ids (validation rejects them upstream)", () => {
    expect(selectedIds(["log", "totally-unknown", "report"]).sort()).toEqual(["log", "report"]);
  });

  it("can resolve the full selectable set", () => {
    const ids = selectedIds([...SELECTABLE_RUNTIME_TOOLS]).sort();
    expect(ids).toEqual([...SELECTABLE_RUNTIME_TOOLS].sort());
  });

  it("returns a concrete factory function for every resolved entry", () => {
    for (const { factory } of selectBuiltinRuntimeToolFactories([...SELECTABLE_RUNTIME_TOOLS])) {
      expect(typeof factory).toBe("function");
    }
  });
});

describe("BUILTIN_RUNTIME_TOOL_FACTORIES", () => {
  it("keys === SELECTABLE_RUNTIME_TOOLS", () => {
    expect(Object.keys(BUILTIN_RUNTIME_TOOL_FACTORIES)).toEqual([...SELECTABLE_RUNTIME_TOOLS]);
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
    expect([...SELECTABLE_RUNTIME_TOOLS]).toEqual(["output", "log", "note", "pin", "report"]);
  });
});
