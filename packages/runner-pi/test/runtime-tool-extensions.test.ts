// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { buildRuntimeToolExtensions } from "../src/runtime-tools/runtime-tool-extensions.ts";

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

  it("surfaces output validation errors without emitting", async () => {
    const emitted: unknown[] = [];
    const [factory] = buildRuntimeToolExtensions({
      runtimeTools: ["output"],
      outputSchema: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
      emit: (e) => emitted.push(e),
    });
    const tool = registerOne(factory!);
    const result = await tool.execute("call-1", { data: {} });
    expect(result.isError).toBe(true);
    expect(emitted).toHaveLength(0);
  });
});
