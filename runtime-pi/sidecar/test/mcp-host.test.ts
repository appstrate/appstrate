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
import { McpHost, normaliseNamespace } from "../mcp-host.ts";

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

  it("disambiguates a colliding namespace with a numeric suffix (§5.4.5)", async () => {
    const a = await makeUpstream(fsTool());
    const b = await makeUpstream(notionTool());
    try {
      const events: Array<{ source: string; level: string; data: unknown }> = [];
      const host = new McpHost({ onLog: (e) => events.push(e) });
      await host.register({ namespace: "gmail", client: a.client });
      // Same slug, different upstream (e.g. @official/gmail vs @vendor/gmail).
      await host.register({ namespace: "gmail", client: b.client });
      const names = host
        .buildTools()
        .map((t) => t.descriptor.name)
        .sort();
      // First registration keeps the bare slug; the second is suffixed.
      expect(names).toEqual(["gmail_2__search_pages", "gmail__read_file", "gmail__write_file"]);
      const dis = events.find(
        (e) => (e.data as { event?: string }).event === "namespace_disambiguated",
      );
      expect(dis).toBeDefined();
      expect((dis!.data as { allocated: string }).allocated).toBe("gmail_2");
      expect((dis!.data as { base: string }).base).toBe("gmail");
    } finally {
      await a.pair.close();
      await b.pair.close();
    }
  });

  it("disambiguates a third collision with _3", async () => {
    const a = await makeUpstream(fsTool());
    const b = await makeUpstream(notionTool());
    const c = await makeUpstream([
      {
        descriptor: { name: "third", description: "x", inputSchema: { type: "object" } },
        handler: async () => ({ content: [{ type: "text", text: "third" }] }),
      },
    ]);
    try {
      const host = new McpHost();
      await host.register({ namespace: "gmail", client: a.client });
      await host.register({ namespace: "gmail", client: b.client });
      await host.register({ namespace: "gmail", client: c.client });
      const prefixes = new Set(host.buildTools().map((t) => t.descriptor.name.split("__")[0]));
      expect(prefixes).toEqual(new Set(["gmail", "gmail_2", "gmail_3"]));
    } finally {
      await a.pair.close();
      await b.pair.close();
      await c.pair.close();
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
          name: "api_call",
          description: "first-party",
          inputSchema: { type: "object" },
        },
        handler: async () => ({ content: [{ type: "text", text: "first-party" }] }),
      };
      const tools = host.buildTools([firstParty]);
      const names = tools.map((t) => t.descriptor.name).sort();
      expect(names).toEqual(["api_call", "fs__read_file", "fs__write_file"]);
    } finally {
      await fs.pair.close();
    }
  });

  it("first-party names override third-party collisions", async () => {
    const upstream = await makeUpstream([
      {
        descriptor: {
          name: "api_call",
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
          name: "api_call",
          description: "real first-party",
          inputSchema: { type: "object" },
        },
        handler: async () => ({ content: [{ type: "text", text: "first-party" }] }),
      };
      const tools = host.buildTools([firstParty]);
      const provider = tools.find((t) => t.descriptor.name === "api_call");
      expect(provider!.descriptor.description).toBe("real first-party");
      const result = await provider!.handler({}, { signal: undefined as never } as never);
      expect(result.content[0]).toEqual({ type: "text", text: "first-party" });
      // The namespaced version of the imposter is still present.
      expect(tools.find((t) => t.descriptor.name === "imposter__api_call")).toBeDefined();
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

  // The generic `{ns}__api_call` tool (apiCall integrations) is named from
  // `normaliseNamespace(integrationId)` in integrations-boot — NOT routed through
  // McpHost.register — so the normaliser alone must yield an MCP-name-safe
  // prefix. A raw scoped package id (`@scope/name`) carries `@`/`/` which the
  // SDK's TOOL_NAME_PATTERN rejects → 500 on the agent's `/mcp` POST.
  it("yields an MCP-name-safe prefix for scoped package ids", () => {
    const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;
    for (const id of ["@appstrate/google-drive", "@appstrate/github", "gmail"]) {
      const ns = normaliseNamespace(id);
      expect(ns.length).toBeGreaterThan(0);
      expect(TOOL_NAME_PATTERN.test(`${ns}__api_call`)).toBe(true);
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

// ─────────────────────────────────────────────
// Niveau 2 Phase 3 — allowedTools filter
// ─────────────────────────────────────────────

describe("McpHost — trusted (first-party) bypass of the poisoning sanitiser", () => {
  // The generic `api_call` tool ships a deliberately rich `body` description
  // (multipart / base64 docs the agent needs). A third-party schema that
  // serialises past MAX_SCHEMA_SERIALISED_BYTES (8 KB) is DROPPED by
  // sanitiseToolDescriptor; a trusted first-party one must survive intact.
  function fatSchemaTool(): AppstrateToolDefinition[] {
    return [
      {
        descriptor: {
          name: "api_call",
          description: "x".repeat(4000), // > MAX_TOOL_DESCRIPTION_BYTES (2048)
          inputSchema: {
            type: "object",
            properties: {
              note: { type: "string", description: "y".repeat(6000) }, // > 512 param cap
            },
          },
        },
        handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
      },
    ];
  }

  const noteDescOf = (tool: AppstrateToolDefinition): string =>
    (tool.descriptor.inputSchema as { properties: { note: { description: string } } }).properties
      .note.description;

  it("truncates an untrusted tool's rich docs but keeps the trusted one verbatim", async () => {
    const untrusted = await makeUpstream(fatSchemaTool());
    const trusted = await makeUpstream(fatSchemaTool());
    try {
      const host = new McpHost();
      await host.register({ namespace: "third", client: untrusted.client });
      await host.register({ namespace: "gmail", client: trusted.client, trusted: true });
      const built = host.buildTools();

      // Untrusted: param description capped at 512 bytes + tool description capped.
      const untrustedTool = built.find((t) => t.descriptor.name === "third__api_call")!;
      expect(noteDescOf(untrustedTool).length).toBeLessThanOrEqual(512);
      expect(untrustedTool.descriptor.description!.length).toBeLessThanOrEqual(2048);

      // Trusted: rich docs survive untouched.
      const trustedTool = built.find((t) => t.descriptor.name === "gmail__api_call")!;
      expect(noteDescOf(trustedTool).length).toBe(6000);
      expect(trustedTool.descriptor.description!.length).toBe(4000);
    } finally {
      await untrusted.pair.close();
      await trusted.pair.close();
    }
  });
});

describe("McpHost — allowedTools filter", () => {
  it("registers only the tools in the allowlist (originalName-based)", async () => {
    const fs = await makeUpstream(fsTool());
    try {
      const host = new McpHost();
      await host.register({
        namespace: "fs",
        client: fs.client,
        allowedTools: ["read_file"],
      });
      expect(host.size()).toBe(1);
      const built = host.buildTools();
      expect(built.map((t) => t.descriptor.name)).toEqual(["fs__read_file"]);
    } finally {
      await fs.pair.close();
    }
  });

  it("undefined allowedTools preserves the legacy 'all tools allowed' default", async () => {
    const fs = await makeUpstream(fsTool());
    try {
      const host = new McpHost();
      await host.register({ namespace: "fs", client: fs.client });
      expect(host.size()).toBe(2);
    } finally {
      await fs.pair.close();
    }
  });

  it("empty allowlist registers nothing (explicit lockdown)", async () => {
    const fs = await makeUpstream(fsTool());
    try {
      const host = new McpHost();
      await host.register({
        namespace: "fs",
        client: fs.client,
        allowedTools: [],
      });
      expect(host.size()).toBe(0);
    } finally {
      await fs.pair.close();
    }
  });

  it("emits a 'tool_excluded_by_allowlist' log entry for each filtered tool", async () => {
    const fs = await makeUpstream(fsTool());
    try {
      const logs: Array<{ source: string; level: string; data: unknown }> = [];
      const host = new McpHost({ onLog: (e) => logs.push(e) });
      await host.register({
        namespace: "fs",
        client: fs.client,
        allowedTools: ["read_file"],
      });
      const excluded = logs.filter((l) => {
        const d = l.data as Record<string, unknown>;
        return d?.event === "tool_excluded_by_allowlist";
      });
      expect(excluded).toHaveLength(1);
      expect((excluded[0]!.data as { originalName: string }).originalName).toBe("write_file");
    } finally {
      await fs.pair.close();
    }
  });

  it("allowlist using the namespaced name does NOT match (we filter by original name)", async () => {
    const fs = await makeUpstream(fsTool());
    try {
      const host = new McpHost();
      await host.register({
        namespace: "fs",
        client: fs.client,
        // Mistake: caller passed `fs__read_file` instead of `read_file`.
        // The filter is intentionally strict to make the failure visible
        // (zero tools registered) rather than silently let through.
        allowedTools: ["fs__read_file"],
      });
      expect(host.size()).toBe(0);
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

describe("McpHost — intoNamespace (attachable api_call)", () => {
  // Simulates the attachable-api_call wiring: a spawned server registers under
  // a namespace, then the in-process api_call tool merges into it.
  function apiCallTool(): AppstrateToolDefinition[] {
    return [
      {
        descriptor: { name: "api_call", description: "raw HTTP", inputSchema: { type: "object" } },
        handler: async () => ({ content: [{ type: "text", text: "api_call-result" }] }),
      },
    ];
  }

  it("merges tools into an existing namespace, keeping the primary upstream", async () => {
    const server = await makeUpstream(notionTool()); // native: search_pages
    const apiCall = await makeUpstream(apiCallTool());
    const host = new McpHost();
    try {
      const ns = await host.register({ namespace: "kijiji", client: server.client });
      const merged = await host.register({
        namespace: "kijiji",
        client: apiCall.client,
        trusted: true,
        intoNamespace: ns,
      });
      // Same namespace — no `_2` suffix.
      expect(merged).toBe("kijiji");
      const names = host.buildTools().map((t) => t.descriptor.name);
      expect(names).toContain("kijiji__search_pages");
      expect(names).toContain("kijiji__api_call");
      // The primary upstream (getUpstreamClient / connect-login) stays the
      // spawned server, NOT the merged api_call client.
      expect(host.getUpstreamClient("kijiji")).toBe(server.client);
    } finally {
      await host.dispose();
    }
  });

  it("routes each merged tool to its OWN client", async () => {
    const server = await makeUpstream(notionTool());
    const apiCall = await makeUpstream(apiCallTool());
    const host = new McpHost();
    try {
      const ns = await host.register({ namespace: "kijiji", client: server.client });
      await host.register({
        namespace: "kijiji",
        client: apiCall.client,
        trusted: true,
        intoNamespace: ns,
      });
      const tools = host.buildTools();
      const search = tools.find((t) => t.descriptor.name === "kijiji__search_pages")!;
      const apicall = tools.find((t) => t.descriptor.name === "kijiji__api_call")!;
      const r1 = await search.handler({}, {} as never);
      const r2 = await apicall.handler({}, {} as never);
      expect((r1.content as [{ text: string }])[0].text).toBe("notion-results");
      expect((r2.content as [{ text: string }])[0].text).toBe("api_call-result");
    } finally {
      await host.dispose();
    }
  });

  it("throws when intoNamespace targets an unregistered namespace", async () => {
    const apiCall = await makeUpstream(apiCallTool());
    const host = new McpHost();
    try {
      await expect(
        host.register({ namespace: "kijiji", client: apiCall.client, intoNamespace: "ghost" }),
      ).rejects.toThrow(/not a registered namespace/);
    } finally {
      await host.dispose();
    }
  });
});
