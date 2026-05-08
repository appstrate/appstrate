// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach } from "bun:test";
import { wrapExtensionFactory } from "../extension-wrapper.ts";

// --- Emit spy via DI (no mock.module needed) ---

const emitCalls: Record<string, unknown>[] = [];
const emitSpy = (obj: Record<string, unknown>) => {
  emitCalls.push(obj);
};

// Shared no-op ctx for tests that don't exercise the 4th arg. Throws on use
// so that any unexpected access surfaces immediately.
const stubCtx = {
  providerCall: async () => {
    throw new Error("stubCtx.providerCall used in a test that did not wire ctx");
  },
  readResource: async () => {
    throw new Error("stubCtx.readResource used in a test that did not wire ctx");
  },
};
const stubCtxProvider = () => stubCtx as any;

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

  it("passes through a correct 3-param execute and its return value", async () => {
    const expected = { content: [{ type: "text", text: "ok" }] };
    const factory = makeFactory(
      async (_id: string, _params: unknown, _signal: unknown) => expected,
    );

    const wrapped = wrapExtensionFactory(factory as any, "ext-1", stubCtxProvider, emitSpy);
    const pi = createMockPi();
    wrapped(pi as any);

    expect(pi.registeredTools).toHaveLength(1);
    const result = await pi.registeredTools[0].execute("call-1", { input: "hi" }, null);
    expect(result).toEqual(expected);
    // No error emissions
    expect(emitCalls.filter((c) => c.type === "error")).toHaveLength(0);
  });

  it("catches errors thrown by execute and returns an error result", async () => {
    const factory = makeFactory(async () => {
      throw new Error("something broke");
    });

    const wrapped = wrapExtensionFactory(factory as any, "ext-err", stubCtxProvider, emitSpy);
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

  it("catches non-Error thrown values", async () => {
    const factory = makeFactory(async () => {
      throw "raw string error";
    });

    const wrapped = wrapExtensionFactory(factory as any, "ext-raw", stubCtxProvider, emitSpy);
    const pi = createMockPi();
    wrapped(pi as any);

    const result = await pi.registeredTools[0].execute("call-1", {}, null);
    expect(result.content[0].text).toContain("raw string error");
  });

  it("skips wrapping when execute is not a function", () => {
    const factory = (pi: any) => {
      pi.registerTool({ name: "no-exec", description: "test" });
    };

    const wrapped = wrapExtensionFactory(factory as any, "ext-noexec", stubCtxProvider, emitSpy);
    const pi = createMockPi();
    wrapped(pi as any);

    expect(pi.registeredTools).toHaveLength(1);
    expect(pi.registeredTools[0].execute).toBeUndefined();
  });

  it("forwards all three arguments to the original execute", async () => {
    let receivedArgs: unknown[] = [];
    const factory = makeFactory(async (id: string, params: unknown, signal: unknown) => {
      receivedArgs = [id, params, signal];
      return { content: [{ type: "text", text: "done" }] };
    });

    const wrapped = wrapExtensionFactory(factory as any, "ext-args", stubCtxProvider, emitSpy);
    const pi = createMockPi();
    wrapped(pi as any);

    const params = { key: "value" };
    const signal = new AbortController().signal;
    await pi.registeredTools[0].execute("call-42", params, signal);

    expect(receivedArgs[0]).toBe("call-42");
    expect(receivedArgs[1]).toBe(params);
    expect(receivedArgs[2]).toBe(signal);
  });

  it("includes tool name in error result", async () => {
    const factory = makeFactory(async () => {
      throw new Error("fail");
    }, "my_special_tool");

    const wrapped = wrapExtensionFactory(factory as any, "ext-name", stubCtxProvider, emitSpy);
    const pi = createMockPi();
    wrapped(pi as any);

    const result = await pi.registeredTools[0].execute("call-1", {}, null);
    expect(result.content[0].text).toContain("my_special_tool");
  });

  // --- AppstrateCtxProvider (4th-arg credentialed-call surface) ---

  it("passes the live ctx as the 4th argument when appstrateCtxProvider resolves", async () => {
    let receivedCtx: any = undefined;
    const factory = makeFactory(
      async (_id: string, _params: unknown, _signal: unknown, ctx: any) => {
        receivedCtx = ctx;
        return { content: [{ type: "text", text: "ok" }] };
      },
    );

    const liveCtx = {
      providerCall: async (_pid: string, _args: unknown) => ({
        content: [{ type: "text", text: "from sidecar" }],
      }),
    };

    const wrapped = wrapExtensionFactory(
      factory as any,
      "ext-live-ctx",
      () => liveCtx as any,
      emitSpy,
    );
    const pi = createMockPi();
    wrapped(pi as any);

    await pi.registeredTools[0].execute("call-1", {}, null);
    expect(receivedCtx).toBe(liveCtx);
    expect(typeof receivedCtx.providerCall).toBe("function");
  });

  it("re-evaluates the provider on each execute (late binding)", async () => {
    // Simulates the entrypoint flow: factories collected before the MCP
    // client is wired; the ctx ref is swapped at Phase C. The wrapper must
    // read the provider at execute time, not at factory invocation time.
    const stubCtx = {
      providerCall: async () => {
        throw new Error("not ready");
      },
    };
    const wiredCtx = {
      providerCall: async () => ({ content: [{ type: "text", text: "wired" }] }),
    };
    let liveCtx: any = stubCtx;

    let receivedCtx: any = undefined;
    const factory = makeFactory(
      async (_id: string, _params: unknown, _signal: unknown, ctx: any) => {
        receivedCtx = ctx;
        return { content: [{ type: "text", text: "ok" }] };
      },
    );

    const wrapped = wrapExtensionFactory(factory as any, "ext-late-bind", () => liveCtx, emitSpy);
    const pi = createMockPi();
    wrapped(pi as any);

    await pi.registeredTools[0].execute("call-1", {}, null);
    expect(receivedCtx).toBe(stubCtx);

    liveCtx = wiredCtx;

    await pi.registeredTools[0].execute("call-2", {}, null);
    expect(receivedCtx).toBe(wiredCtx);
  });

  it("forwards providerCall return value untouched to the tool", async () => {
    let providerCallResult: any = undefined;
    const factory = makeFactory(
      async (_id: string, _params: unknown, _signal: unknown, ctx: any) => {
        providerCallResult = await ctx.providerCall("@scope/test", {
          target: "https://example.com",
        });
        return { content: [{ type: "text", text: "ok" }] };
      },
    );

    const stubbedResponse = {
      content: [{ type: "text", text: "from upstream" }],
      isError: false,
      structuredContent: { foo: "bar" },
    };

    const liveCtx = {
      providerCall: async (_pid: string, _args: unknown) => stubbedResponse,
    };

    const wrapped = wrapExtensionFactory(
      factory as any,
      "ext-passthrough",
      () => liveCtx as any,
      emitSpy,
    );
    const pi = createMockPi();
    wrapped(pi as any);

    await pi.registeredTools[0].execute("call-1", {}, null);
    expect(providerCallResult).toEqual(stubbedResponse);
  });
});
