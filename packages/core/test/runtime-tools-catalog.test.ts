// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  SELECTABLE_RUNTIME_TOOLS,
  RUNTIME_TOOL_CATALOG,
  isSelectableRuntimeTool,
} from "../src/runtime-tools-catalog.ts";

describe("runtime-tools-catalog", () => {
  it("SELECTABLE set is exactly [output, log, note, pin, report]", () => {
    // Guards against drift with runner-pi's local SELECTABLE_RUNTIME_TOOLS,
    // which duplicates this list (the published runner package must not take
    // a hard @appstrate/core dependency). If you change one, change both.
    expect([...SELECTABLE_RUNTIME_TOOLS]).toEqual(["output", "log", "note", "pin", "report"]);
  });

  it("output is present in the catalog and selectable like every other tool", () => {
    const output = RUNTIME_TOOL_CATALOG.find((e) => e.id === "output");
    expect(output).toBeDefined();
    expect(isSelectableRuntimeTool("output")).toBe(true);
  });

  it("catalog ids == SELECTABLE_RUNTIME_TOOLS, in listing order", () => {
    expect(RUNTIME_TOOL_CATALOG.map((e) => e.id)).toEqual([...SELECTABLE_RUNTIME_TOOLS]);
  });

  it("isSelectableRuntimeTool accepts every catalog id only", () => {
    for (const id of SELECTABLE_RUNTIME_TOOLS) {
      expect(isSelectableRuntimeTool(id)).toBe(true);
    }
    expect(isSelectableRuntimeTool("unknown")).toBe(false);
    expect(isSelectableRuntimeTool(42)).toBe(false);
    expect(isSelectableRuntimeTool(undefined)).toBe(false);
  });
});
