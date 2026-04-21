// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import {
  registerAfpsTools,
  type PiExtensionRegistrar,
  type PiToolConfig,
} from "../../src/runner/pi-tools.ts";
import type { AfpsEvent } from "../../src/types/afps-event.ts";

function fakeRegistrar(): PiExtensionRegistrar & { tools: Map<string, PiToolConfig> } {
  const tools = new Map<string, PiToolConfig>();
  return {
    tools,
    registerTool(config: PiToolConfig) {
      tools.set(config.name, config);
      return undefined;
    },
  };
}

const PARAMS = {
  addMemory: { kind: "addMemory" },
  setState: { kind: "setState" },
  output: { kind: "output" },
  report: { kind: "report" },
  log: { kind: "log" },
};

describe("registerAfpsTools", () => {
  it("registers all 5 AFPS platform tools", () => {
    const pi = fakeRegistrar();
    registerAfpsTools(pi, { emit: async () => undefined, parametersFactory: PARAMS });
    expect([...pi.tools.keys()].sort()).toEqual([
      "add_memory",
      "log",
      "output",
      "report",
      "set_state",
    ]);
  });

  it("wires the parametersFactory entries onto each tool", () => {
    const pi = fakeRegistrar();
    registerAfpsTools(pi, { emit: async () => undefined, parametersFactory: PARAMS });
    expect(pi.tools.get("add_memory")!.parameters).toBe(PARAMS.addMemory);
    expect(pi.tools.get("set_state")!.parameters).toBe(PARAMS.setState);
    expect(pi.tools.get("output")!.parameters).toBe(PARAMS.output);
    expect(pi.tools.get("report")!.parameters).toBe(PARAMS.report);
    expect(pi.tools.get("log")!.parameters).toBe(PARAMS.log);
  });

  it("add_memory emits an add_memory AfpsEvent when invoked", async () => {
    const pi = fakeRegistrar();
    const emitted: AfpsEvent[] = [];
    registerAfpsTools(pi, {
      emit: async (e) => {
        emitted.push(e);
      },
      parametersFactory: PARAMS,
    });
    await pi.tools.get("add_memory")!.execute("id", { content: "hello" });
    expect(emitted).toEqual([{ type: "add_memory", content: "hello" }]);
  });

  it("set_state emits set_state with the raw state value", async () => {
    const pi = fakeRegistrar();
    const emitted: AfpsEvent[] = [];
    registerAfpsTools(pi, {
      emit: async (e) => {
        emitted.push(e);
      },
      parametersFactory: PARAMS,
    });
    await pi.tools.get("set_state")!.execute("id", { state: { counter: 7 } });
    expect(emitted).toEqual([{ type: "set_state", state: { counter: 7 } }]);
  });

  it("output emits output with the data field", async () => {
    const pi = fakeRegistrar();
    const emitted: AfpsEvent[] = [];
    registerAfpsTools(pi, {
      emit: async (e) => {
        emitted.push(e);
      },
      parametersFactory: PARAMS,
    });
    await pi.tools.get("output")!.execute("id", { data: { done: true } });
    expect(emitted).toEqual([{ type: "output", data: { done: true } }]);
  });

  it("report emits report with the content string", async () => {
    const pi = fakeRegistrar();
    const emitted: AfpsEvent[] = [];
    registerAfpsTools(pi, {
      emit: async (e) => {
        emitted.push(e);
      },
      parametersFactory: PARAMS,
    });
    await pi.tools.get("report")!.execute("id", { content: "all clear" });
    expect(emitted).toEqual([{ type: "report", content: "all clear" }]);
  });

  it("log emits log with the level + message", async () => {
    const pi = fakeRegistrar();
    const emitted: AfpsEvent[] = [];
    registerAfpsTools(pi, {
      emit: async (e) => {
        emitted.push(e);
      },
      parametersFactory: PARAMS,
    });
    await pi.tools.get("log")!.execute("id", { level: "warn", message: "watch out" });
    expect(emitted).toEqual([{ type: "log", level: "warn", message: "watch out" }]);
  });

  it("each tool returns the MCP-shaped content result", async () => {
    const pi = fakeRegistrar();
    registerAfpsTools(pi, { emit: async () => undefined, parametersFactory: PARAMS });
    for (const [name, args] of [
      ["add_memory", { content: "m" }],
      ["set_state", { state: {} }],
      ["output", { data: {} }],
      ["report", { content: "r" }],
      ["log", { level: "info", message: "m" }],
    ] as const) {
      const r = await pi.tools.get(name)!.execute("id", args);
      expect(r.content).toBeArray();
      expect(r.content[0]!.type).toBe("text");
      expect(typeof r.content[0]!.text).toBe("string");
    }
  });
});
