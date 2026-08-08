// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  SELECTABLE_RUNTIME_TOOLS,
  EVENT_EMITTER_RUNTIME_TOOLS,
  RUNTIME_TOOL_CATALOG,
  isSelectableRuntimeTool,
} from "../src/runtime-tools-catalog.ts";

describe("runtime-tools-catalog", () => {
  it("SELECTABLE set is the event emitters plus the publishing tool", () => {
    // Guards against drift with the OpenAPI manifest enum + the agent-editor
    // checklist, which mirror this list. If you change one, change all.
    expect([...SELECTABLE_RUNTIME_TOOLS]).toEqual([
      "output",
      "log",
      "note",
      "pin",
      "publish_document",
    ]);
  });

  it("EVENT_EMITTER set is the four standalone-buildable emitters", () => {
    // These are the tools `buildRuntimeToolDefs` builds standalone;
    // The publishing tool is deliberately excluded (it needs injected dependencies).
    expect([...EVENT_EMITTER_RUNTIME_TOOLS]).toEqual(["output", "log", "note", "pin"]);
  });

  it("output is present in the catalog and selectable like every other tool", () => {
    const output = RUNTIME_TOOL_CATALOG.find((e) => e.id === "output");
    expect(output).toBeDefined();
    expect(isSelectableRuntimeTool("output")).toBe(true);
  });

  it("catalog covers every selectable id — nothing hidden", () => {
    expect(RUNTIME_TOOL_CATALOG.map((e) => e.id)).toEqual([...SELECTABLE_RUNTIME_TOOLS]);
  });

  it("the retired report tool is no longer selectable", () => {
    expect(isSelectableRuntimeTool("report")).toBe(false);
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
