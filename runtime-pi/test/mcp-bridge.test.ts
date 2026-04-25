// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the runtime-pi MCP bridge (Phase 2 of #276).
 *
 * Strategy:
 *   - Build an in-process MCP server exposing `provider_call` and
 *     `run_history` tools (mirroring the sidecar's surface).
 *   - Connect a client through `createInProcessPair` and feed the
 *     resulting SDK Client into the same `wrapClient` the production
 *     entrypoint consumes.
 *   - Drive `buildMcpProviderFactories` and `buildMcpRunHistoryFactory`
 *     against this client and verify each generated Pi extension
 *     dispatches a `tools/call` carrying the right `providerId` and
 *     forwards results back into the AgentToolResult shape.
 *
 * The Pi `ExtensionAPI` is mocked: we only need `registerTool` to
 * capture the tool descriptor and execute() handler. Everything else
 * (workspace, runId, emit) is plain function injection.
 */

import { describe, it, expect } from "bun:test";
import {
  createInProcessPair,
  wrapClient,
  type AppstrateMcpClient,
  type AppstrateToolDefinition,
} from "@appstrate/mcp-transport";
import type { Bundle, PackageIdentity } from "@appstrate/afps-runtime/bundle";
import {
  buildMcpProviderFactories,
  buildMcpRunHistoryFactory,
  providerToolName,
} from "../extensions/mcp-bridge.ts";

interface CapturedTool {
  name: string;
  description: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<unknown>;
}

function makeMockExtensionApi(captured: CapturedTool[]) {
  return {
    registerTool: (tool: {
      name: string;
      label?: string;
      description?: string;
      parameters: unknown;
      execute: CapturedTool["execute"];
    }) => {
      captured.push({
        name: tool.name,
        description: tool.description ?? "",
        parameters: tool.parameters,
        execute: tool.execute,
      });
    },
  } as never;
}

function makeBundleWithProviders(providers: Record<string, string>): Bundle {
  const identity = "@test/agent@0.0.0" as PackageIdentity;
  return {
    bundleFormatVersion: "1.0",
    root: identity,
    packages: new Map([
      [
        identity,
        {
          identity,
          manifest: {
            name: "@test/agent",
            version: "0.0.0",
            type: "agent",
            dependencies: { providers },
          },
          files: new Map(),
          integrity: "" as never,
        },
      ],
    ]),
    integrity: "" as never,
  } as Bundle;
}

interface MockServer {
  pair: Awaited<ReturnType<typeof createInProcessPair>>;
  mcp: AppstrateMcpClient;
  calls: Array<{ name: string; arguments?: Record<string, unknown> }>;
}

async function makeMockServer(extra: AppstrateToolDefinition[] = []): Promise<MockServer> {
  const calls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];

  const providerCall: AppstrateToolDefinition = {
    descriptor: {
      name: "provider_call",
      description: "mock",
      inputSchema: { type: "object" },
    },
    handler: async (args) => {
      calls.push({ name: "provider_call", arguments: args });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ providerId: args.providerId, target: args.target }),
          },
        ],
      };
    },
  };

  const runHistory: AppstrateToolDefinition = {
    descriptor: {
      name: "run_history",
      description: "mock",
      inputSchema: { type: "object" },
    },
    handler: async (args) => {
      calls.push({ name: "run_history", arguments: args });
      return {
        content: [{ type: "text" as const, text: JSON.stringify([{ runId: "prev" }]) }],
      };
    },
  };

  const pair = await createInProcessPair([providerCall, runHistory, ...extra]);
  const mcp = wrapClient(pair.client, { close: () => Promise.resolve() });
  return { pair, mcp, calls };
}

describe("providerToolName", () => {
  it("normalises scoped package names to snake_case + _call suffix", () => {
    expect(providerToolName("@appstrate/gmail")).toBe("appstrate_gmail_call");
    expect(providerToolName("@appstrate/click-up")).toBe("appstrate_click_up_call");
    expect(providerToolName("notion")).toBe("notion_call");
  });

  it("collapses runs of separators", () => {
    expect(providerToolName("@scope///pkg..name")).toBe("scope_pkg_name_call");
  });

  it("strips leading/trailing underscores after sanitisation", () => {
    expect(providerToolName("__weird__")).toBe("weird_call");
  });
});

describe("buildMcpProviderFactories", () => {
  it("returns [] when bundle declares no providers", async () => {
    const { mcp, pair } = await makeMockServer();
    try {
      const factories = await buildMcpProviderFactories({
        bundle: makeBundleWithProviders({}),
        mcp,
        runId: "run-1",
        workspace: "/tmp",
        emitProvider: () => {},
      });
      expect(factories).toEqual([]);
    } finally {
      await pair.close();
    }
  });

  it("registers one Pi extension per declared provider", async () => {
    const { mcp, pair } = await makeMockServer();
    try {
      const factories = await buildMcpProviderFactories({
        bundle: makeBundleWithProviders({
          "@appstrate/gmail": "^1.0.0",
          "@appstrate/clickup": "^1.0.0",
        }),
        mcp,
        runId: "run-1",
        workspace: "/tmp",
        emitProvider: () => {},
      });
      const captured: CapturedTool[] = [];
      const api = makeMockExtensionApi(captured);
      for (const f of factories) f(api);
      expect(captured.map((c) => c.name).sort()).toEqual([
        "appstrate_clickup_call",
        "appstrate_gmail_call",
      ]);
    } finally {
      await pair.close();
    }
  });

  it("dispatches tools/call with the correct providerId", async () => {
    const { mcp, pair, calls } = await makeMockServer();
    try {
      const factories = await buildMcpProviderFactories({
        bundle: makeBundleWithProviders({ "@appstrate/gmail": "^1.0.0" }),
        mcp,
        runId: "run-1",
        workspace: "/tmp",
        emitProvider: () => {},
      });
      const captured: CapturedTool[] = [];
      factories[0]!(makeMockExtensionApi(captured));
      const result = await captured[0]!.execute("tc-1", {
        target: "https://api.example.com",
        method: "GET",
      });
      const providerCalls = calls.filter((c) => c.name === "provider_call");
      expect(providerCalls).toHaveLength(1);
      expect(providerCalls[0]!.arguments).toEqual({
        providerId: "@appstrate/gmail",
        target: "https://api.example.com",
        method: "GET",
      });
      expect(result).toEqual({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              providerId: "@appstrate/gmail",
              target: "https://api.example.com",
            }),
          },
        ],
        details: undefined,
      });
    } finally {
      await pair.close();
    }
  });

  it("emits provider.called → provider.completed lifecycle events", async () => {
    const { mcp, pair } = await makeMockServer();
    try {
      const events: Array<{ type: string }> = [];
      const factories = await buildMcpProviderFactories({
        bundle: makeBundleWithProviders({ "@appstrate/gmail": "^1.0.0" }),
        mcp,
        runId: "run-1",
        workspace: "/tmp",
        emitProvider: (e) => events.push(e as { type: string }),
      });
      const captured: CapturedTool[] = [];
      factories[0]!(makeMockExtensionApi(captured));
      await captured[0]!.execute("tc-1", { target: "https://example.com" });
      expect(events.map((e) => e.type)).toEqual(["provider.called", "provider.completed"]);
    } finally {
      await pair.close();
    }
  });

  it("emits provider.failed when the upstream tool throws", async () => {
    const failingTool: AppstrateToolDefinition = {
      descriptor: {
        name: "provider_call",
        description: "always fails",
        inputSchema: { type: "object" },
      },
      handler: async () => {
        throw new Error("upstream down");
      },
    };
    const pair = await createInProcessPair([
      failingTool,
      {
        descriptor: {
          name: "run_history",
          description: "noop",
          inputSchema: { type: "object" },
        },
        handler: async () => ({ content: [{ type: "text" as const, text: "[]" }] }),
      },
    ]);
    const mcp = wrapClient(pair.client, { close: () => Promise.resolve() });
    try {
      const events: Array<{ type: string }> = [];
      const factories = await buildMcpProviderFactories({
        bundle: makeBundleWithProviders({ "@appstrate/gmail": "^1.0.0" }),
        mcp,
        runId: "run-1",
        workspace: "/tmp",
        emitProvider: (e) => events.push(e as { type: string }),
      });
      const captured: CapturedTool[] = [];
      factories[0]!(makeMockExtensionApi(captured));
      let caught: unknown;
      try {
        await captured[0]!.execute("tc-1", { target: "https://example.com" });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(events.map((e) => e.type)).toEqual(["provider.called", "provider.failed"]);
    } finally {
      await pair.close();
    }
  });

  it("fails fast if the server does not advertise provider_call", async () => {
    // Construct an MCP server with NO provider_call tool — the bridge
    // must surface the misconfig at boot, not on first agent call.
    const pair = await createInProcessPair([
      {
        descriptor: {
          name: "run_history",
          description: "only run_history",
          inputSchema: { type: "object" },
        },
        handler: async () => ({ content: [{ type: "text" as const, text: "[]" }] }),
      },
    ]);
    const mcp = wrapClient(pair.client, { close: () => Promise.resolve() });
    try {
      let caught: unknown;
      try {
        await buildMcpProviderFactories({
          bundle: makeBundleWithProviders({ "@appstrate/gmail": "^1.0.0" }),
          mcp,
          runId: "run-1",
          workspace: "/tmp",
          emitProvider: () => {},
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain("provider_call");
    } finally {
      await pair.close();
    }
  });
});

describe("buildMcpRunHistoryFactory", () => {
  it("registers a single run_history Pi extension", async () => {
    const { mcp, pair } = await makeMockServer();
    try {
      const factory = buildMcpRunHistoryFactory({ mcp, runId: "run-1", emit: () => {} });
      const captured: CapturedTool[] = [];
      factory(makeMockExtensionApi(captured));
      expect(captured).toHaveLength(1);
      expect(captured[0]!.name).toBe("run_history");
    } finally {
      await pair.close();
    }
  });

  it("forwards limit + fields through the MCP call", async () => {
    const { mcp, pair, calls } = await makeMockServer();
    try {
      const factory = buildMcpRunHistoryFactory({ mcp, runId: "run-1", emit: () => {} });
      const captured: CapturedTool[] = [];
      factory(makeMockExtensionApi(captured));
      await captured[0]!.execute("tc-1", { limit: 5, fields: ["state"] });
      const rh = calls.filter((c) => c.name === "run_history");
      expect(rh).toHaveLength(1);
      expect(rh[0]!.arguments).toEqual({ limit: 5, fields: ["state"] });
    } finally {
      await pair.close();
    }
  });

  it("emits run_history.called → run_history.completed lifecycle events", async () => {
    const { mcp, pair } = await makeMockServer();
    try {
      const events: Array<{ type: string }> = [];
      const factory = buildMcpRunHistoryFactory({
        mcp,
        runId: "run-1",
        emit: (e) => events.push(e as { type: string }),
      });
      const captured: CapturedTool[] = [];
      factory(makeMockExtensionApi(captured));
      await captured[0]!.execute("tc-1", { limit: 3 });
      expect(events.map((e) => e.type)).toEqual(["run_history.called", "run_history.completed"]);
    } finally {
      await pair.close();
    }
  });
});
