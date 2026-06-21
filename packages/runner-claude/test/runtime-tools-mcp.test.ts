// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import type { RunEvent } from "@appstrate/afps-runtime/types";
import {
  buildRuntimeToolDefinitions,
  buildRuntimeToolsMcpServer,
} from "../src/runtime-tools-mcp.ts";

function collector() {
  const events: RunEvent[] = [];
  const emit = async (e: RunEvent): Promise<void> => {
    events.push(e);
  };
  return { events, emit };
}

describe("buildRuntimeToolDefinitions", () => {
  it("returns [] when no in-process runtime tools are selected", () => {
    const { emit } = collector();
    expect(buildRuntimeToolDefinitions({ emit })).toEqual([]);
    expect(buildRuntimeToolDefinitions({ runtimeTools: [], emit })).toEqual([]);
  });

  it("excludes `output` (native via outputFormat) and unknown tools", () => {
    const { emit } = collector();
    const defs = buildRuntimeToolDefinitions({
      runtimeTools: ["output", "log", "note", "bogus"],
      emit,
    });
    const names = defs.map((d) => d.descriptor.name);
    expect(names).toContain("log");
    expect(names).toContain("note");
    expect(names).not.toContain("output");
    expect(names).not.toContain("bogus");
  });

  it("re-emits a tool's canonical events to the sink and returns model-facing text", async () => {
    const { events, emit } = collector();
    const [logDef] = buildRuntimeToolDefinitions({ runtimeTools: ["log"], emit });
    const result = await logDef!.handler({ level: "warn", message: "careful" }, {} as never);

    // The canonical event reached the run sink…
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "log.written", level: "warn", message: "careful" });
    expect(events[0]).toHaveProperty("timestamp");

    // …and the tool returned only model-facing content (no `_meta` leak).
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect((result as Record<string, unknown>)._meta).toBeUndefined();
  });

  it("forwards a pinned slot via the `pin` tool", async () => {
    const { events, emit } = collector();
    const [pinDef] = buildRuntimeToolDefinitions({ runtimeTools: ["pin"], emit });
    await pinDef!.handler({ key: "checkpoint", content: { step: 3 } }, {} as never);
    expect(events[0]).toMatchObject({
      type: "pinned.set",
      key: "checkpoint",
      content: { step: 3 },
    });
  });
});

describe("buildRuntimeToolsMcpServer", () => {
  it("returns null when nothing is hosted in-process", () => {
    const { emit } = collector();
    expect(buildRuntimeToolsMcpServer({ runtimeTools: ["output"], emit })).toBeNull();
    expect(buildRuntimeToolsMcpServer({ emit })).toBeNull();
  });

  it("builds a live server with the selected tool names and a default mount name", () => {
    const { emit } = collector();
    const mcp = buildRuntimeToolsMcpServer({ runtimeTools: ["log", "report"], emit });
    expect(mcp).not.toBeNull();
    expect(mcp!.name).toBe("appstrate_runtime");
    expect(mcp!.toolNames.sort()).toEqual(["log", "report"]);
    expect(mcp!.server).toBeDefined();
  });

  it("honours a custom mount name", () => {
    const { emit } = collector();
    const mcp = buildRuntimeToolsMcpServer({ runtimeTools: ["log"], emit, serverName: "rt" });
    expect(mcp!.name).toBe("rt");
  });
});
