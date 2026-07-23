// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  SELECTABLE_RUNTIME_TOOLS,
  EVENT_EMITTER_RUNTIME_TOOLS,
  RUNTIME_TOOL_CATALOG,
  isSelectableRuntimeTool,
} from "../src/runtime-tools-catalog.ts";

describe("runtime-tools-catalog", () => {
  it("SELECTABLE set is the event emitters plus publish_document", () => {
    // Guards against drift with the OpenAPI manifest enum + the agent-editor
    // checklist, which mirror this list. If you change one, change all.
    expect([...SELECTABLE_RUNTIME_TOOLS]).toEqual([
      "output",
      "log",
      "note",
      "pin",
      "report",
      "publish_document",
    ]);
  });

  it("EVENT_EMITTER set includes the deprecated report compatibility tool", () => {
    // These are the tools `buildRuntimeToolDefs` builds standalone;
    // `publish_document` is deliberately excluded (it needs an injected uploader).
    expect([...EVENT_EMITTER_RUNTIME_TOOLS]).toEqual(["output", "log", "note", "pin", "report"]);
  });

  it("output is present in the catalog and selectable like every other tool", () => {
    const output = RUNTIME_TOOL_CATALOG.find((e) => e.id === "output");
    expect(output).toBeDefined();
    expect(isSelectableRuntimeTool("output")).toBe(true);
  });

  it("hides deprecated report from the new-agent catalog", () => {
    expect(RUNTIME_TOOL_CATALOG.map((e) => e.id)).toEqual([
      "output",
      "log",
      "note",
      "pin",
      "publish_document",
    ]);
    expect(isSelectableRuntimeTool("report")).toBe(true);
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
