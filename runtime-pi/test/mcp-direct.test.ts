// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the runtime-pi direct MCP tool surface.
 *
 * Strategy:
 *   - Build an in-process MCP server exposing `provider_call`,
 *     `run_history`, and `llm_complete`.
 *   - Drive `buildMcpDirectFactories` against it.
 *   - Verify the LLM-facing Pi tools are registered with their canonical
 *     MCP names and dispatch correctly.
 */

import { describe, it, expect } from "bun:test";
import { tmpdir } from "node:os";
import {
  createInProcessPair,
  wrapClient,
  type AppstrateMcpClient,
  type AppstrateToolDefinition,
} from "@appstrate/mcp-transport";
import type { Bundle, PackageIdentity } from "@appstrate/afps-runtime/bundle";
import { buildMcpDirectFactories, DIRECT_TOOL_PROMPT } from "../extensions/mcp-direct.ts";

// Provider tools never resolve `{ fromFile }` against this workspace
// in these tests — the body is always a string or absent — but
// `runner-pi`'s factory requires a workspace path for its
// `AfpsToolContext`, so we point at a stable directory.
const TEST_WORKSPACE = tmpdir();

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

async function makeMockServer(): Promise<MockServer> {
  const calls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
  const tool = (name: string, response: unknown): AppstrateToolDefinition => ({
    descriptor: { name, description: "mock", inputSchema: { type: "object" } },
    handler: async (args) => {
      calls.push({ name, arguments: args });
      return { content: [{ type: "text" as const, text: JSON.stringify(response) }] };
    },
  });
  const pair = await createInProcessPair([
    tool("provider_call", { ok: true }),
    tool("run_history", []),
    tool("llm_complete", { id: "ok" }),
  ]);
  const mcp = wrapClient(pair.client, { close: () => Promise.resolve() });
  return { pair, mcp, calls };
}

describe("DIRECT_TOOL_PROMPT (D5.1)", () => {
  it("is a 3-line capability prompt", () => {
    expect(DIRECT_TOOL_PROMPT.split("\n")).toHaveLength(3);
    expect(DIRECT_TOOL_PROMPT).toContain("MCP");
  });
});

describe("buildMcpDirectFactories — provider_call registration (D5.3)", () => {
  it("registers a single provider_call tool with a providerId enum", async () => {
    const { mcp, pair, calls } = await makeMockServer();
    try {
      const factories = await buildMcpDirectFactories({
        bundle: makeBundleWithProviders({
          "@appstrate/gmail": "^1.0.0",
          "@appstrate/clickup": "^1.0.0",
        }),
        mcp,
        runId: "run-1",
        workspace: TEST_WORKSPACE,
        emitProvider: () => {},
        emit: () => {},
      });
      const captured: CapturedTool[] = [];
      const api = makeMockExtensionApi(captured);
      for (const f of factories) f(api);

      const providerCall = captured.find((c) => c.name === "provider_call");
      expect(providerCall).toBeDefined();
      expect(captured.find((c) => c.name === "run_history")).toBeDefined();
      expect(captured.find((c) => c.name === "llm_complete")).toBeDefined();

      // No legacy aliases.
      expect(captured.find((c) => c.name === "appstrate_gmail_call")).toBeUndefined();

      // providerId enum mirrors the bundle declaration.
      const params = providerCall!.parameters as {
        properties: { providerId: { enum: string[] } };
      };
      expect(params.properties.providerId.enum.sort()).toEqual([
        "@appstrate/clickup",
        "@appstrate/gmail",
      ]);

      // Dispatch test. The Pi tool flows through runner-pi's
      // dispatcher → AFPS tool wrapper → McpProviderResolver →
      // mcp.callTool — every layer is wired through the same factory
      // CLI mode uses, so the MCP envelope sent to the sidecar carries
      // the providerId, target, and method (the AFPS provider_call
      // schema requires `method`).
      await providerCall!.execute("call-1", {
        providerId: "@appstrate/gmail",
        target: "https://example.com",
        method: "GET",
      });
      expect(calls).toEqual([
        {
          name: "provider_call",
          arguments: {
            providerId: "@appstrate/gmail",
            target: "https://example.com",
            method: "GET",
          },
        },
      ]);
    } finally {
      await pair.close();
    }
  });

  it("omits provider_call when the bundle declares no providers", async () => {
    const { mcp, pair } = await makeMockServer();
    try {
      const factories = await buildMcpDirectFactories({
        bundle: makeBundleWithProviders({}),
        mcp,
        runId: "run-1",
        workspace: TEST_WORKSPACE,
        emitProvider: () => {},
        emit: () => {},
      });
      const captured: CapturedTool[] = [];
      const api = makeMockExtensionApi(captured);
      for (const f of factories) f(api);
      expect(captured.find((c) => c.name === "provider_call")).toBeUndefined();
      // run_history + llm_complete are always registered.
      expect(captured.map((c) => c.name).sort()).toEqual(["llm_complete", "run_history"]);
    } finally {
      await pair.close();
    }
  });
});

describe("buildMcpDirectFactories — run_history dispatch", () => {
  it("forwards limit + fields to the MCP run_history tool", async () => {
    const { mcp, pair, calls } = await makeMockServer();
    try {
      const factories = await buildMcpDirectFactories({
        bundle: makeBundleWithProviders({}),
        mcp,
        runId: "run-1",
        workspace: TEST_WORKSPACE,
        emitProvider: () => {},
        emit: () => {},
      });
      const captured: CapturedTool[] = [];
      const api = makeMockExtensionApi(captured);
      for (const f of factories) f(api);
      const runHistory = captured.find((c) => c.name === "run_history");
      await runHistory!.execute("call-1", { limit: 5, fields: ["state"] });
      expect(calls).toEqual([{ name: "run_history", arguments: { limit: 5, fields: ["state"] } }]);
    } finally {
      await pair.close();
    }
  });
});

describe("buildMcpDirectFactories — llm_complete dispatch", () => {
  it("forwards the LLM completion request through MCP", async () => {
    const { mcp, pair, calls } = await makeMockServer();
    try {
      const factories = await buildMcpDirectFactories({
        bundle: makeBundleWithProviders({}),
        mcp,
        runId: "run-1",
        workspace: TEST_WORKSPACE,
        emitProvider: () => {},
        emit: () => {},
      });
      const captured: CapturedTool[] = [];
      const api = makeMockExtensionApi(captured);
      for (const f of factories) f(api);
      const llmComplete = captured.find((c) => c.name === "llm_complete");
      await llmComplete!.execute("call-1", { path: "/v1/messages", body: '{"x":1}' });
      expect(calls).toEqual([
        {
          name: "llm_complete",
          arguments: { path: "/v1/messages", body: '{"x":1}' },
        },
      ]);
    } finally {
      await pair.close();
    }
  });
});

describe("buildMcpDirectFactories — failure modes", () => {
  it("throws when the sidecar does not advertise an expected tool", async () => {
    const pair = await createInProcessPair([
      {
        descriptor: {
          name: "provider_call",
          description: "mock",
          inputSchema: { type: "object" },
        },
        handler: async () => ({ content: [{ type: "text", text: "" }] }),
      },
    ]);
    const mcp = wrapClient(pair.client, { close: () => Promise.resolve() });
    try {
      await expect(
        buildMcpDirectFactories({
          bundle: makeBundleWithProviders({}),
          mcp,
          runId: "run-1",
          workspace: TEST_WORKSPACE,
          emitProvider: () => {},
          emit: () => {},
        }),
      ).rejects.toThrow(/run_history/);
    } finally {
      await pair.close();
    }
  });
});
