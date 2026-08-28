// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  SELECTABLE_RUNTIME_TOOLS,
  EVENT_EMITTER_RUNTIME_TOOLS,
  RUNTIME_TOOL_CATALOG,
  canonicalizeRuntimeToolIds,
  isSelectableRuntimeTool,
} from "../src/runtime-tools-catalog.ts";

describe("runtime-tools-catalog", () => {
  it("SELECTABLE set is the event emitters plus the publishing tool", () => {
    // Spelled out literally on purpose: recomposing the expectation from the
    // same expression the source composes it from would pass whatever the
    // source said. Guards against drift with the OpenAPI manifest enum + the
    // agent-editor checklist, which mirror this list, and with the Zod
    // `runtime_tools` enum and the generated AFPS JSON Schema, which are built
    // from it — an id missing here stops a persisted manifest validating. If
    // you change one, change all.
    expect([...SELECTABLE_RUNTIME_TOOLS]).toEqual(["output", "log", "note", "pin", "publish_file"]);
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

// ---------------------------------------------------------------------------
// Reading stored ids — no alias table any more (#1177's was removed)
// ---------------------------------------------------------------------------

describe("runtime-tool id reading", () => {
  it("the retired publish_document spelling is known nowhere", () => {
    expect(isSelectableRuntimeTool("publish_document")).toBe(false);
    expect(RUNTIME_TOOL_CATALOG.map((e) => e.id)).not.toContain("publish_document" as never);
    expect([...SELECTABLE_RUNTIME_TOOLS]).not.toContain("publish_document" as never);
  });

  it("drops the retired spelling and REPORTS it rather than resolving it", () => {
    // The removed alias would have rewritten this to `publish_file`. The
    // contract now is a reported drop — never a silent one, and never a guess.
    expect(canonicalizeRuntimeToolIds(["log", "publish_document"])).toEqual({
      ids: ["log"],
      dropped: ["publish_document"],
      changed: true,
    });
  });

  it("leaves an already-canonical list untouched", () => {
    expect(canonicalizeRuntimeToolIds(["output", "publish_file"])).toEqual({
      ids: ["output", "publish_file"],
      dropped: [],
      changed: false,
    });
  });

  it("collapses a duplicate, preserving the author's order", () => {
    expect(canonicalizeRuntimeToolIds(["publish_file", "output", "publish_file"])).toEqual({
      ids: ["publish_file", "output"],
      dropped: [],
      changed: true,
    });
  });

  it("drops an id that resolves to nothing, including non-strings", () => {
    expect(canonicalizeRuntimeToolIds(["output", "report", 42, undefined])).toEqual({
      ids: ["output"],
      dropped: ["report", "42", "undefined"],
      changed: true,
    });
  });
});
