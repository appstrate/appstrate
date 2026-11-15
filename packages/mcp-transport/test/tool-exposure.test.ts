// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { exposeTool, toolExclusion, MAX_SCHEMA_SERIALISED_BYTES, type Tool } from "../src/index.ts";

const tool = (name: string, extra: Partial<Tool> = {}): Tool => ({
  name,
  description: `Tool ${name}`,
  inputSchema: { type: "object" },
  ...extra,
});

const free = { namespace: "docs", isTaken: () => false };

describe("exposeTool", () => {
  it("exposes an admitted tool as {namespace}__{name}", () => {
    expect(exposeTool(tool("search"), free)).toEqual({
      descriptor: {
        name: "docs__search",
        description: "Tool search",
        inputSchema: { type: "object" },
      },
    });
  });

  it("sanitises the descriptor and drops one too large once sanitised", () => {
    const properties = Object.fromEntries(
      Array.from({ length: MAX_SCHEMA_SERIALISED_BYTES / 16 }, (_, i) => [
        `property_${i}`,
        { type: "string" },
      ]),
    );
    const big = { type: "object", properties };
    const exposed = exposeTool(tool("a", { description: "hi\u200Bthere" }), free);
    expect("descriptor" in exposed && exposed.descriptor.description).toBe("hithere");
    expect(exposeTool(tool("a", { inputSchema: big as Tool["inputSchema"] }), free)).toEqual({
      exclusion: "schema_too_large_after_sanitisation",
    });
  });

  it("renames a taken name and leads the description with the upstream name", () => {
    const taken = new Set(["docs__a_b"]);
    const exposed = exposeTool(tool("a.b"), { ...free, isTaken: (name) => taken.has(name) });
    if (!("descriptor" in exposed)) throw new Error("not exposed");
    expect(exposed.descriptor.name).toMatch(/^docs__a_b_[0-9a-f]{8}$/);
    expect(exposed.descriptor.description).toBe('Upstream tool name: "a.b".\n\nTool a.b');
  });

  it("reports a name left without a free candidate", () => {
    expect(exposeTool(tool("a"), { ...free, isTaken: () => true })).toEqual({
      exclusion: "name_collision",
    });
  });
});

describe("toolExclusion", () => {
  it("excludes a tool outside the selection, then a hidden one", () => {
    const allowlist = new Set(["a", "b"]);
    const hidden = new Set(["b"]);
    expect(toolExclusion("c", allowlist, hidden)).toBe("allowlist");
    expect(toolExclusion("b", allowlist, hidden)).toBe("hidden_tools");
    expect(toolExclusion("a", allowlist, hidden)).toBeNull();
    expect(toolExclusion("c", null, null)).toBeNull();
  });
});
