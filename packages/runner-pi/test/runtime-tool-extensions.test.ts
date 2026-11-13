// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { buildOutputExtension } from "../src/runtime-tools/runtime-tool-extensions.ts";

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
