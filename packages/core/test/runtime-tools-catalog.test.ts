// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  MANDATORY_RUNTIME_TOOLS,
  SELECTABLE_RUNTIME_TOOLS,
  ALL_RUNTIME_TOOLS,
  RUNTIME_TOOL_CATALOG,
  isSelectableRuntimeTool,
} from "../src/runtime-tools-catalog.ts";

describe("runtime-tools-catalog", () => {
  it("MANDATORY set is exactly [output]", () => {
    expect([...MANDATORY_RUNTIME_TOOLS]).toEqual(["output"]);
  });

  it("SELECTABLE set is exactly [log, note, pin, report]", () => {
    // Guards against drift with runner-pi's local SELECTABLE_RUNTIME_TOOLS,
    // which duplicates this list (the published runner package must not take
    // a hard @appstrate/core dependency). If you change one, change both.
    expect([...SELECTABLE_RUNTIME_TOOLS]).toEqual(["log", "note", "pin", "report"]);
  });

  it("ALL = mandatory ++ selectable", () => {
    expect([...ALL_RUNTIME_TOOLS]).toEqual([
      ...MANDATORY_RUNTIME_TOOLS,
      ...SELECTABLE_RUNTIME_TOOLS,
    ]);
  });

  it("'tool' package type was removed — output is mandatory in the catalog", () => {
    const output = RUNTIME_TOOL_CATALOG.find((e) => e.id === "output");
    expect(output).toBeDefined();
    expect(output!.mandatory).toBe(true);
  });

  it("every selectable catalog entry is non-mandatory", () => {
    for (const id of SELECTABLE_RUNTIME_TOOLS) {
      const entry = RUNTIME_TOOL_CATALOG.find((e) => e.id === id);
      expect(entry).toBeDefined();
      expect(entry!.mandatory).toBe(false);
    }
  });

  it("catalog ids == ALL_RUNTIME_TOOLS, in listing order", () => {
    expect(RUNTIME_TOOL_CATALOG.map((e) => e.id)).toEqual([...ALL_RUNTIME_TOOLS]);
  });

  it("isSelectableRuntimeTool accepts selectable ids only", () => {
    for (const id of SELECTABLE_RUNTIME_TOOLS) {
      expect(isSelectableRuntimeTool(id)).toBe(true);
    }
    expect(isSelectableRuntimeTool("output")).toBe(false);
    expect(isSelectableRuntimeTool("unknown")).toBe(false);
    expect(isSelectableRuntimeTool(42)).toBe(false);
    expect(isSelectableRuntimeTool(undefined)).toBe(false);
  });
});
