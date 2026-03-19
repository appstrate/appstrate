import { describe, test, expect, mock, beforeEach } from "bun:test";

// Mock emit before importing the wrapper
const emitCalls: Record<string, unknown>[] = [];
mock.module("../lib/emit.ts", () => ({
  emit(obj: Record<string, unknown>) {
    emitCalls.push(obj);
  },
}));

const { wrapExtensionFactory } = await import("../extension-wrapper.ts");

// --- Helpers ---

/** Build a minimal pi-like object that records registerTool calls. */
function createMockPi() {
  const registeredTools: any[] = [];
  return {
    registeredTools,
    registerTool(config: any) {
      registeredTools.push(config);
    },
  };
}

/** Create an extension factory that registers a single tool with the given execute fn. */
function makeFactory(executeFn: (...args: any[]) => any, toolName = "test_tool") {
  return (pi: any) => {
    pi.registerTool({
      name: toolName,
      description: "test",
      parameters: { type: "object", properties: {} },
      execute: executeFn,
    });
  };
}

// --- Tests ---

describe("wrapExtensionFactory", () => {
  beforeEach(() => {
    emitCalls.length = 0;
  });

  test("passes through a correct 3-param execute and its return value", async () => {
    const expected = { content: [{ type: "text", text: "ok" }] };
    const factory = makeFactory(async (_id: string, _params: unknown, _signal: unknown) => expected);

    const wrapped = wrapExtensionFactory(factory as any, "ext-1");
    const pi = createMockPi();
    wrapped(pi as any);

    expect(pi.registeredTools).toHaveLength(1);
    const result = await pi.registeredTools[0].execute("call-1", { input: "hi" }, null);
    expect(result).toEqual(expected);
    // No error emissions
    expect(emitCalls.filter((c) => c.type === "error")).toHaveLength(0);
  });

  test("catches errors thrown by execute and returns an error result", async () => {
    const factory = makeFactory(async () => {
      throw new Error("something broke");
    });

    const wrapped = wrapExtensionFactory(factory as any, "ext-err");
    const pi = createMockPi();
    wrapped(pi as any);

    const result = await pi.registeredTools[0].execute("call-1", {}, null);

    // Returns a proper MCP error result instead of throwing
    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toContain("something broke");
    expect(result.content[0].text).toContain("ext-err");

    // Emits an error event
    const errorEmits = emitCalls.filter((c) => c.type === "error");
    expect(errorEmits).toHaveLength(1);
    expect(errorEmits[0].message).toContain("something broke");
  });

  test("catches non-Error thrown values", async () => {
    const factory = makeFactory(async () => {
      throw "raw string error";
    });

    const wrapped = wrapExtensionFactory(factory as any, "ext-raw");
    const pi = createMockPi();
    wrapped(pi as any);

    const result = await pi.registeredTools[0].execute("call-1", {}, null);
    expect(result.content[0].text).toContain("raw string error");
  });

  test("skips wrapping when execute is not a function", () => {
    const factory = (pi: any) => {
      pi.registerTool({ name: "no-exec", description: "test" });
    };

    const wrapped = wrapExtensionFactory(factory as any, "ext-noexec");
    const pi = createMockPi();
    wrapped(pi as any);

    expect(pi.registeredTools).toHaveLength(1);
    expect(pi.registeredTools[0].execute).toBeUndefined();
  });

  test("forwards all three arguments to the original execute", async () => {
    let receivedArgs: unknown[] = [];
    const factory = makeFactory(async (id: string, params: unknown, signal: unknown) => {
      receivedArgs = [id, params, signal];
      return { content: [{ type: "text", text: "done" }] };
    });

    const wrapped = wrapExtensionFactory(factory as any, "ext-args");
    const pi = createMockPi();
    wrapped(pi as any);

    const params = { key: "value" };
    const signal = new AbortController().signal;
    await pi.registeredTools[0].execute("call-42", params, signal);

    expect(receivedArgs[0]).toBe("call-42");
    expect(receivedArgs[1]).toBe(params);
    expect(receivedArgs[2]).toBe(signal);
  });

  test("includes tool name in error result", async () => {
    const factory = makeFactory(
      async () => {
        throw new Error("fail");
      },
      "my_special_tool",
    );

    const wrapped = wrapExtensionFactory(factory as any, "ext-name");
    const pi = createMockPi();
    wrapped(pi as any);

    const result = await pi.registeredTools[0].execute("call-1", {}, null);
    expect(result.content[0].text).toContain("my_special_tool");
  });
});
