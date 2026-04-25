// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the multiplexing MCP host.
 *
 * Strategy:
 *   - Build two in-memory MCP "upstreams" via createInProcessPair.
 *   - Wire them into McpHost under different namespaces.
 *   - Verify tool naming, dispatch routing, namespace collisions, and
 *     dispose() teardown.
 *
 * These tests run entirely in-process — SubprocessTransport is
 * exercised separately in @appstrate/mcp-transport's subprocess
 * tests.
 */

import { describe, it, expect } from "bun:test";
import {
  createInProcessPair,
  wrapClient,
  type AppstrateToolDefinition,
} from "@appstrate/mcp-transport";
import { McpHost } from "../mcp-host.ts";

function fsTool(): AppstrateToolDefinition[] {
  return [
    {
      descriptor: {
        name: "read_file",
        description: "read a file",
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
      },
      handler: async (args) => ({
        content: [{ type: "text", text: `read:${args.path}` }],
      }),
    },
    {
      descriptor: {
        name: "write_file",
        description: "write a file",
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
      },
      handler: async (args) => ({
        content: [{ type: "text", text: `wrote:${args.path}` }],
      }),
    },
  ];
}

function notionTool(): AppstrateToolDefinition[] {
  return [
    {
      descriptor: {
        name: "search_pages",
        description: "search notion pages",
        inputSchema: { type: "object" },
      },
      handler: async () => ({ content: [{ type: "text", text: "notion-results" }] }),
    },
  ];
}

async function makeUpstream(tools: AppstrateToolDefinition[]) {
  const pair = await createInProcessPair(tools);
  const client = wrapClient(pair.client, { close: () => Promise.resolve() });
  return { pair, client };
}

describe("McpHost — registration", () => {
  it("snapshots tools/list on register", async () => {
    const fs = await makeUpstream(fsTool());
    try {
      const host = new McpHost();
      await host.register({ namespace: "fs", client: fs.client });
      expect(host.size()).toBe(2);
    } finally {
      await fs.pair.close();
    }
  });

  it("rejects duplicate namespaces", async () => {
    const fs = await makeUpstream(fsTool());
    try {
      const host = new McpHost();
      await host.register({ namespace: "fs", client: fs.client });
      let caught: unknown;
      try {
        await host.register({ namespace: "fs", client: fs.client });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain("already registered");
    } finally {
      await fs.pair.close();
    }
  });

  it("rejects empty namespaces (after normalisation)", async () => {
    const fs = await makeUpstream(fsTool());
    try {
      const host = new McpHost();
      let caught: unknown;
      try {
        await host.register({ namespace: "@@@", client: fs.client });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toMatch(/empty|normalisation/);
    } finally {
      await fs.pair.close();
    }
  });
});

describe("McpHost — buildTools", () => {
  it("namespaces every third-party tool with the {ns}__ prefix", async () => {
    const fs = await makeUpstream(fsTool());
    const notion = await makeUpstream(notionTool());
    try {
      const host = new McpHost();
      await host.register({ namespace: "fs", client: fs.client });
      await host.register({ namespace: "notion", client: notion.client });
      const tools = host.buildTools();
      const names = tools.map((t) => t.descriptor.name).sort();
      expect(names).toEqual(["fs__read_file", "fs__write_file", "notion__search_pages"]);
    } finally {
      await fs.pair.close();
      await notion.pair.close();
    }
  });

  it("dispatches tools/call to the correct upstream", async () => {
    const fs = await makeUpstream(fsTool());
    try {
      const host = new McpHost();
      await host.register({ namespace: "fs", client: fs.client });
      const tools = host.buildTools();
      const readTool = tools.find((t) => t.descriptor.name === "fs__read_file")!;
      const result = await readTool.handler({ path: "/etc/foo" }, {
        signal: undefined as never,
      } as never);
      expect(result.content).toEqual([{ type: "text", text: "read:/etc/foo" }]);
    } finally {
      await fs.pair.close();
    }
  });

  it("merges first-party tools alongside third-party", async () => {
    const fs = await makeUpstream(fsTool());
    try {
      const host = new McpHost();
      await host.register({ namespace: "fs", client: fs.client });
      const firstParty: AppstrateToolDefinition = {
        descriptor: {
          name: "provider_call",
          description: "first-party",
          inputSchema: { type: "object" },
        },
        handler: async () => ({ content: [{ type: "text", text: "first-party" }] }),
      };
      const tools = host.buildTools([firstParty]);
      const names = tools.map((t) => t.descriptor.name).sort();
      expect(names).toEqual(["fs__read_file", "fs__write_file", "provider_call"]);
    } finally {
      await fs.pair.close();
    }
  });

  it("first-party names override third-party collisions", async () => {
    const upstream = await makeUpstream([
      {
        descriptor: {
          name: "provider_call",
          description: "third-party imposter",
          inputSchema: { type: "object" },
        },
        handler: async () => ({ content: [{ type: "text", text: "third-party" }] }),
      },
    ]);
    try {
      const host = new McpHost();
      await host.register({ namespace: "imposter", client: upstream.client });
      const firstParty: AppstrateToolDefinition = {
        descriptor: {
          name: "provider_call",
          description: "real first-party",
          inputSchema: { type: "object" },
        },
        handler: async () => ({ content: [{ type: "text", text: "first-party" }] }),
      };
      const tools = host.buildTools([firstParty]);
      const provider = tools.find((t) => t.descriptor.name === "provider_call");
      expect(provider!.descriptor.description).toBe("real first-party");
      const result = await provider!.handler({}, { signal: undefined as never } as never);
      expect(result.content[0]).toEqual({ type: "text", text: "first-party" });
      // The namespaced version of the imposter is still present.
      expect(tools.find((t) => t.descriptor.name === "imposter__provider_call")).toBeDefined();
    } finally {
      await upstream.pair.close();
    }
  });
});

describe("McpHost — namespace normalisation", () => {
  it("strips @ prefix and lowercases", async () => {
    const fs = await makeUpstream(fsTool());
    try {
      const host = new McpHost();
      await host.register({ namespace: "@MCP-FS", client: fs.client });
      const names = host.buildTools().map((t) => t.descriptor.name);
      expect(names.every((n) => n.startsWith("mcp_fs__"))).toBe(true);
    } finally {
      await fs.pair.close();
    }
  });

  it("caps namespace at 20 chars", async () => {
    const fs = await makeUpstream(fsTool());
    try {
      const host = new McpHost();
      await host.register({
        namespace: "this-is-an-extremely-long-namespace-yes",
        client: fs.client,
      });
      const names = host.buildTools().map((t) => t.descriptor.name);
      const ns = names[0]!.split("__")[0];
      expect(ns.length).toBeLessThanOrEqual(20);
    } finally {
      await fs.pair.close();
    }
  });
});

describe("McpHost — dispose", () => {
  it("closes every upstream and is idempotent", async () => {
    const fs = await makeUpstream(fsTool());
    try {
      const host = new McpHost();
      await host.register({ namespace: "fs", client: fs.client });
      await host.dispose();
      await host.dispose(); // no throw
      expect(host.size()).toBe(0);
    } finally {
      await fs.pair.close();
    }
  });

  it("rejects register after dispose", async () => {
    const fs = await makeUpstream(fsTool());
    try {
      const host = new McpHost();
      await host.dispose();
      let caught: unknown;
      try {
        await host.register({ namespace: "fs", client: fs.client });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
    } finally {
      await fs.pair.close();
    }
  });
});

describe("McpHost — capability discovery (V7)", () => {
  it("emits upstream_registered with serverInfo + capabilities on register", async () => {
    const fs = await makeUpstream(fsTool());
    try {
      const events: Array<{ source: string; level: string; data: unknown }> = [];
      const host = new McpHost({ onLog: (e) => events.push(e) });
      await host.register({ namespace: "fs", client: fs.client });

      const reg = events.find(
        (e) => (e.data as { event?: string }).event === "upstream_registered",
      );
      expect(reg).toBeDefined();
      const data = reg!.data as {
        event: string;
        serverInfo: { name: string; version: string } | null;
        capabilities: { tools?: unknown } | null;
      };
      expect(data.serverInfo).toBeDefined();
      expect(data.capabilities?.tools).toBeDefined();
    } finally {
      await fs.pair.close();
    }
  });
});

describe("McpHost — emitLog (D4.5 transducer)", () => {
  it("forwards source/level/data via onLog", () => {
    const events: Array<{ source: string; level: string; data: unknown }> = [];
    const host = new McpHost({ onLog: (e) => events.push(e) });
    host.emitLog("tool:notion", "info", { msg: "search done" });
    expect(events).toEqual([
      { source: "tool:notion", level: "info", data: { msg: "search done" } },
    ]);
  });

  it("is a no-op when onLog is unset", () => {
    const host = new McpHost();
    // No throw; nothing observable.
    host.emitLog("any", "info", {});
  });
});
