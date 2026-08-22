// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  SELECTABLE_RUNTIME_TOOLS,
  EVENT_EMITTER_RUNTIME_TOOLS,
  RUNTIME_TOOL_CATALOG,
  ACCEPTED_RUNTIME_TOOL_IDS,
  LEGACY_RUNTIME_TOOL_ALIASES,
  canonicalRuntimeToolId,
  canonicalizeRuntimeToolIds,
  isSelectableRuntimeTool,
} from "../src/runtime-tools-catalog.ts";

describe("runtime-tools-catalog", () => {
  it("SELECTABLE set is the event emitters plus the publishing tool", () => {
    // Guards against drift with the OpenAPI manifest enum + the agent-editor
    // checklist, which mirror this list. If you change one, change all.
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
// Legacy id aliasing (#1177: `publish_document` → `publish_file`)
// ---------------------------------------------------------------------------

describe("runtime-tool legacy aliases", () => {
  it("publish_document maps forward to publish_file", () => {
    expect(LEGACY_RUNTIME_TOOL_ALIASES.publish_document).toBe("publish_file");
    expect(canonicalRuntimeToolId("publish_document")).toBe("publish_file");
  });

  it("a legacy id is NOT selectable — the editor never offers it as a new choice", () => {
    expect(isSelectableRuntimeTool("publish_document")).toBe(false);
    expect(RUNTIME_TOOL_CATALOG.map((e) => e.id)).not.toContain("publish_document" as never);
    expect([...SELECTABLE_RUNTIME_TOOLS]).not.toContain("publish_document" as never);
  });

  it("the accepted-id list is canonical ids plus every legacy spelling", () => {
    expect([...ACCEPTED_RUNTIME_TOOL_IDS] as string[]).toEqual([
      ...SELECTABLE_RUNTIME_TOOLS,
      ...Object.keys(LEGACY_RUNTIME_TOOL_ALIASES),
    ]);
  });

  it("canonicalRuntimeToolId returns null only for genuinely unknown ids", () => {
    expect(canonicalRuntimeToolId("report")).toBeNull();
    expect(canonicalRuntimeToolId(42)).toBeNull();
    expect(canonicalRuntimeToolId(undefined)).toBeNull();
    expect(canonicalRuntimeToolId("output")).toBe("output");
  });

  it("canonicalizeRuntimeToolIds resolves a legacy id and reports the rewrite", () => {
    expect(canonicalizeRuntimeToolIds(["log", "publish_document"])).toEqual({
      ids: ["log", "publish_file"],
      dropped: [],
      changed: true,
    });
  });

  it("canonicalizeRuntimeToolIds collapses both spellings into one entry", () => {
    expect(canonicalizeRuntimeToolIds(["publish_document", "publish_file"]).ids).toEqual([
      "publish_file",
    ]);
    expect(canonicalizeRuntimeToolIds(["publish_file", "publish_document"]).ids).toEqual([
      "publish_file",
    ]);
  });

  it("canonicalizeRuntimeToolIds leaves an already-canonical list untouched", () => {
    expect(canonicalizeRuntimeToolIds(["output", "publish_file"])).toEqual({
      ids: ["output", "publish_file"],
      dropped: [],
      changed: false,
    });
  });

  it("canonicalizeRuntimeToolIds still drops an id that resolves to nothing", () => {
    expect(canonicalizeRuntimeToolIds(["output", "report"])).toEqual({
      ids: ["output"],
      dropped: ["report"],
      changed: true,
    });
  });
});
