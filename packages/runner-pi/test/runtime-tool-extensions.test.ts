// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  buildOutputExtension,
  buildRuntimeToolExtensions,
} from "../src/runtime-tools/runtime-tool-extensions.ts";

/** Minimal pi stub capturing registered tools. */
function mockPi() {
  const tools: any[] = [];
  return { tools, registerTool: (cfg: any) => tools.push(cfg) };
}

function registerOne(factory: (pi: any) => void) {
  const pi = mockPi();
  factory(pi);
  return pi.tools[0];
}

describe("buildRuntimeToolExtensions", () => {
  it("builds one Pi factory per selected runtime tool", () => {
    const factories = buildRuntimeToolExtensions({ runtimeTools: ["log", "note"] });
    expect(factories).toHaveLength(2);
    const names = factories.map((f) => registerOne(f).name);
    expect(names.sort()).toEqual(["log", "note"]);
  });

  it("runs the shared handler and re-emits its canonical events via emit", async () => {
    const emitted: Array<{ type: string; [k: string]: unknown }> = [];
    const [factory] = buildRuntimeToolExtensions({
      runtimeTools: ["log"],
      emit: (e) => emitted.push(e),
    });
    const tool = registerOne(factory!);
    const result = await tool.execute("call-1", { level: "warn", message: "heads up" });
    expect(result.content[0].text).toContain("Logged [warn]");
    expect(emitted).toEqual([
      { type: "log.written", level: "warn", message: "heads up", timestamp: expect.any(Number) },
    ]);
  });

  it("never builds `output`, even when a stored selection still names it", () => {
    const factories = buildRuntimeToolExtensions({ runtimeTools: ["output", "log"] });
    expect(factories.map((f) => registerOne(f).name)).toEqual(["log"]);
  });
});

describe("buildOutputExtension", () => {
  const schema = { type: "object", properties: { n: { type: "number" } }, required: ["n"] };

  it("throws output validation errors (Pi's tool-error signal) without emitting", async () => {
    const emitted: unknown[] = [];
    const tool = registerOne(buildOutputExtension(schema, (e) => emitted.push(e)));
    expect(tool.name).toBe("output");
    await expect(tool.execute("call-1", { data: {} })).rejects.toThrow("validation failed");
    expect(emitted).toHaveLength(0);
  });

  it("emits `output.emitted` for a valid call", async () => {
    const emitted: unknown[] = [];
    const tool = registerOne(buildOutputExtension(schema, (e) => emitted.push(e)));
    await tool.execute("call-1", { data: { n: 1 } });
    expect(emitted).toEqual([
      { type: "output.emitted", data: { n: 1 }, timestamp: expect.any(Number) },
    ]);
  });
});
