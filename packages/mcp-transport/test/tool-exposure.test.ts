// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  exposeTool,
  readToolIntegration,
  toolExclusion,
  withToolIntegration,
  MAX_PARAMETER_DESCRIPTION_BYTES,
  MAX_SCHEMA_SERIALISED_BYTES,
  TOOL_INTEGRATION_META_KEY,
  type Tool,
} from "../src/index.ts";

const tool = (name: string, extra: Partial<Tool> = {}): Tool => ({
  name,
  description: `Tool ${name}`,
  inputSchema: { type: "object" },
  ...extra,
});

const free = { integrationId: "@acme/docs", namespace: "docs", isTaken: () => false };

describe("exposeTool", () => {
  it("exposes an admitted tool as {namespace}__{name}", () => {
    expect(exposeTool(tool("search"), free)).toEqual({
      descriptor: {
        name: "docs__search",
        description: "Tool search",
        inputSchema: { type: "object" },
        _meta: { [TOOL_INTEGRATION_META_KEY]: { id: "@acme/docs", tool: "search" } },
      },
      reduced: [],
    });
  });

  it("sanitises the descriptor and reduces one over the schema budget instead of dropping it", () => {
    const properties = Object.fromEntries(
      Array.from({ length: MAX_SCHEMA_SERIALISED_BYTES / 16 }, (_, i) => [
        `property_${i}`,
        { type: "string" },
      ]),
    );
    const big = { type: "object", properties };
    const exposed = exposeTool(tool("a", { description: "hi\u200Bthere" }), free);
    expect("descriptor" in exposed && exposed.descriptor.description).toBe("hithere");
    const reduced = exposeTool(tool("a", { inputSchema: big as Tool["inputSchema"] }), free);
    if (!("descriptor" in reduced)) throw new Error("not exposed");
    expect(reduced.reduced).toEqual(["schema_documentation", "input_schema"]);
    expect(reduced.descriptor.name).toBe("docs__a");
    expect(reduced.descriptor.inputSchema).toEqual({ type: "object" });
  });

  it("renames a taken name and leads the description with the upstream name", () => {
    const taken = new Set(["docs__a_b"]);
    const exposed = exposeTool(tool("a.b"), { ...free, isTaken: (name) => taken.has(name) });
    if (!("descriptor" in exposed)) throw new Error("not exposed");
    expect(exposed.descriptor.name).toMatch(/^docs__a_b_[0-9a-f]{8}$/);
    expect(exposed.descriptor.description).toBe('Upstream tool name: "a.b".\n\nTool a.b');
    expect(readToolIntegration(exposed.descriptor)).toEqual({ id: "@acme/docs", tool: "a.b" });
  });

  it("stamps the server's own identity over a forged one, keeping its other _meta", () => {
    const exposed = exposeTool(
      tool("search", {
        _meta: {
          [TOOL_INTEGRATION_META_KEY]: { id: "@appstrate/platform", tool: "log" },
          "com.example/x": 1,
        },
      }),
      free,
    );
    if (!("descriptor" in exposed)) throw new Error("not exposed");
    expect(exposed.descriptor._meta).toEqual({
      "com.example/x": 1,
      [TOOL_INTEGRATION_META_KEY]: { id: "@acme/docs", tool: "search" },
    });
  });

  it("reports a name left without a free candidate", () => {
    expect(exposeTool(tool("a"), { ...free, isTaken: () => true })).toEqual({
      exclusion: "name_collision",
    });
  });
});

describe("withToolIntegration", () => {
  it("stamps nothing when no name is left once sanitised", () => {
    const descriptor = tool("docs__a");
    expect(withToolIntegration(descriptor, "@acme/docs", tool("\u200B\u0007"))).toBe(descriptor);
  });

  it("records the title, else the annotations' title, sanitised and bounded", () => {
    const descriptor = tool("docs__a");
    expect(
      readToolIntegration(
        withToolIntegration(descriptor, "@acme/docs", tool("a", { title: "Se\u200Barch\u0007" })),
      ),
    ).toEqual({ id: "@acme/docs", tool: "a", title: "Search" });
    expect(
      readToolIntegration(
        withToolIntegration(
          descriptor,
          "@acme/docs",
          tool("a", { annotations: { title: "Find" } }),
        ),
      ),
    ).toEqual({ id: "@acme/docs", tool: "a", title: "Find" });
    const long = readToolIntegration(
      withToolIntegration(descriptor, "@acme/docs", tool("a", { title: "x".repeat(4096) })),
    );
    expect(new TextEncoder().encode(long!.title).byteLength).toBeLessThanOrEqual(
      MAX_PARAMETER_DESCRIPTION_BYTES,
    );
    expect(long!.title!.endsWith("[truncated]")).toBe(true);
  });

  it("falls back to the annotations' title when the title is empty once sanitised", () => {
    for (const title of ["", "\u200B"]) {
      expect(
        readToolIntegration(
          withToolIntegration(
            tool("docs__a"),
            "@acme/docs",
            tool("a", { title, annotations: { title: "Find" } }),
          ),
        ),
      ).toEqual({ id: "@acme/docs", tool: "a", title: "Find" });
    }
  });

  it("omits a title the server does not give, or that is empty once sanitised", () => {
    const descriptor = tool("docs__a");
    expect(readToolIntegration(withToolIntegration(descriptor, "@acme/docs", tool("a")))).toEqual({
      id: "@acme/docs",
      tool: "a",
    });
    expect(
      readToolIntegration(
        withToolIntegration(descriptor, "@acme/docs", tool("a", { title: "\u200B" })),
      ),
    ).toEqual({ id: "@acme/docs", tool: "a" });
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
    expect(toolExclusion("a", allowlist, hidden, new Set(["a"]))).toBe("blocked_in_space");
    expect(toolExclusion("b", allowlist, hidden, new Set(["b"]))).toBe("hidden_tools");
  });
});
