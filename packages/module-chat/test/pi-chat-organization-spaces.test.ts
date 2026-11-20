// SPDX-License-Identifier: Apache-2.0

/**
 * The tool layer of a conversation: the connection is the organization
 * endpoint, whose space-acting tools each take a `space_id` (a limited
 * conversation's spaces are its origin alone).
 *
 * The local `run_and_wait` takes the space from its arguments (refusing a missing
 * one in the server's own words), strips it before the shared launch, sends it as
 * `X-Space-Id` on the REST hops, and records it on the session first. A forwarded
 * tool and a `read_resource` record the space they name the same way, and the files a call's
 * arguments name record nothing: the platform reads them in that space only. A `read_resource` of
 * a file records the file's space before the read when the turn acts there.
 */

import { describe, expect, it } from "bun:test";
import type { ExtensionAPI } from "@appstrate/runner-pi";
import {
  spaceArgumentRefusal,
  type OrgWideSpaces,
} from "../../../apps/api/src/modules/mcp/spaces.ts";
import { platformMcpUrl } from "../src/platform-mcp.ts";
import { buildPlatformMcpTools, type TurnSpaces } from "../src/pi-chat/mcp-tools.ts";

/** Nothing listens here: a hop that escapes the injected fetch throws. */
const ORIGIN = "http://127.0.0.1:1";
const RUN_ID = "run_org_1";
const SPACES = [
  { id: "spc_alpha", name: "Alpha", role: "operator", permissions: ["files:read"] },
  { id: "spc_beta", name: "Beta", role: "admin", permissions: ["files:read"] },
];

/**
 * What the stub platform refuses: a file named `…private…` (a colleague's, behind its container
 * ACL) or `…nowhere…` (missing). Every other file it serves.
 */
const REFUSED = /appfile:\/\/file_\w*(private|nowhere)/;
const PLATFORM_REFUSAL = { code: "not_found", error: "File not found" };

interface RegisteredTool {
  name: string;
  execute: (
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
  ) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
}

/** Everything the transport saw, in order, with the touches interleaved. */
function transcript() {
  const events: string[] = [];
  const launches: Array<{ spaceHeader: string | null; body: string }> = [];
  const polls: Array<string | null> = [];
  const toolCalls: unknown[] = [];
  const json = (body: unknown, extra?: Record<string, string>) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json", ...extra },
    });

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/mcp/")) {
      if (req.method !== "POST") return new Response(null, { status: 405 });
      const msg = (await req.json()) as { id?: unknown; method?: string; params?: unknown };
      if (msg.id === undefined) return new Response(null, { status: 202 });
      const reply = (result: unknown, extra?: Record<string, string>) =>
        json({ jsonrpc: "2.0", id: msg.id, result }, extra);
      if (msg.method === "initialize") {
        return reply(
          {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {}, resources: {} },
            serverInfo: { name: "stub", version: "1" },
          },
          { "mcp-session-id": "sess_org" },
        );
      }
      if (msg.method === "tools/list") {
        const spaceId = {
          type: "string",
          enum: SPACES.map((space) => space.id),
        };
        return reply({
          tools: [
            {
              name: "run_and_wait",
              description: "Launch a run.",
              inputSchema: {
                type: "object",
                properties: { kind: { type: "string" }, space_id: spaceId },
                required: ["space_id"],
              },
            },
            {
              name: "read",
              inputSchema: {
                type: "object",
                properties: { uri: { type: "string" }, space_id: spaceId },
                required: ["space_id"],
              },
            },
            {
              name: "search",
              inputSchema: {
                type: "object",
                properties: { query: { type: "string" }, space_id: spaceId },
              },
            },
            {
              name: "invoke_operation",
              inputSchema: {
                type: "object",
                properties: { operation_id: { type: "string" }, space_id: spaceId },
                required: ["space_id"],
              },
            },
          ],
        });
      }
      if (msg.method === "tools/call") {
        events.push("tools/call");
        toolCalls.push(msg.params);
        if (REFUSED.test(JSON.stringify(msg.params))) {
          return reply({
            content: [{ type: "text", text: JSON.stringify(PLATFORM_REFUSAL) }],
            isError: true,
          });
        }
        const uri = (msg.params as { arguments?: { uri?: string } }).arguments?.uri;
        if (uri?.startsWith("skill://")) {
          return reply({
            content: [
              { type: "resource", resource: { uri, mimeType: "text/markdown", text: "# Tone" } },
            ],
          });
        }
        return reply({ content: [{ type: "text", text: "{}" }] });
      }
      if (msg.method === "resources/read") {
        events.push("resources/read");
        if (REFUSED.test(JSON.stringify(msg.params))) {
          return json({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32002, message: "not found" },
          });
        }
        return reply({ contents: [{ uri: "x", mimeType: "text/plain", text: "body" }] });
      }
      return reply({});
    }
    if (req.method === "POST" && url.pathname.endsWith("/run")) {
      events.push("launch");
      const body = await req.text();
      launches.push({ spaceHeader: req.headers.get("x-space-id"), body });
      if (REFUSED.test(body)) {
        return new Response(JSON.stringify({ status: 404, detail: "File not found" }), {
          status: 404,
          headers: { "content-type": "application/problem+json" },
        });
      }
      return json({ id: RUN_ID, packageId: "@acme/demo", status: "pending" });
    }
    if (req.method === "GET" && url.pathname === `/api/runs/${RUN_ID}`) {
      polls.push(req.headers.get("x-space-id"));
      return json({ id: RUN_ID, packageId: "@acme/demo", status: "success" });
    }
    if (req.method === "GET" && url.pathname === "/api/files") return json({ data: [] });
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  const lookups: string[] = [];
  return { fetch: fetchImpl, events, launches, polls, toolCalls, lookups };
}

function organizationOf(
  { events, lookups }: ReturnType<typeof transcript>,
  failingTouch?: string,
): TurnSpaces {
  return {
    spaces: SPACES,
    touch: async (spaceId) => {
      if (spaceId === failingTouch) throw new Error(`cannot record ${spaceId}`);
      events.push(`touch ${spaceId}`);
    },
    // A file id names its space here (`file_beta…` → `spc_beta`); `file_own…` is a file the
    // conversation holds and any other id is missing: both name none.
    fileSpace: async (uri) => {
      lookups.push(uri);
      events.push("lookup");
      const space = uri.match(/^appfile:\/\/file_(alpha|beta|gamma)/)?.[1];
      return space ? `spc_${space}` : undefined;
    },
  };
}

async function tools(transport: ReturnType<typeof transcript>, failingTouch?: string) {
  const built = await buildPlatformMcpTools({
    url: platformMcpUrl(ORIGIN, "org_1"),
    headers: { authorization: "Bearer loopback", "x-org-id": "org_1" },
    organization: organizationOf(transport, failingTouch),
    writeChunk: () => {},
    signal: new AbortController().signal,
    turnBudget: { deadlineAt: Date.now() + 10 * 60_000, stepCount: () => 0 },
    fetch: transport.fetch,
  });
  const registered: RegisteredTool[] = [];
  const pi = { registerTool: (tool: RegisteredTool) => registered.push(tool) } as ExtensionAPI;
  for (const factory of built.extensionFactories) factory(pi);
  return { built, tool: (name: string) => registered.find((tool) => tool.name === name)! };
}

const text = (result: { content: Array<{ text: string }> }) => result.content[0]!.text;

describe("a forwarded tool", () => {
  it("refuses a space outside the turn's, in the same words as run_and_wait, before recording it", async () => {
    const transport = transcript();
    const { built, tool } = await tools(transport);
    try {
      const refused = JSON.parse(
        text(
          await tool("invoke_operation").execute("c1", {
            operation_id: "listAgents",
            space_id: "spc_nope",
          }),
        ),
      );
      expect(refused.code).toBe("unknown_space");
      expect(refused.accepted).toEqual(SPACES.map((space) => space.id));
      expect(transport.events).toEqual([]);
      expect(transport.toolCalls).toEqual([]);
    } finally {
      await built.close();
    }
  });
});

describe("the conversation's run_and_wait", () => {
  it("takes the space from its arguments, strips it, sends it as X-Space-Id, and records it first", async () => {
    const transport = transcript();
    const { built, tool } = await tools(transport);
    try {
      const result = await tool("run_and_wait").execute("call_1", {
        kind: "agent",
        scope: "@acme",
        name: "demo",
        space_id: "spc_beta",
      });
      expect(JSON.parse(text(result))).toMatchObject({ id: RUN_ID, status: "success" });
      // Recorded before anything was launched.
      expect(transport.events.slice(0, 2)).toEqual(["touch spc_beta", "launch"]);
      // The launch body never carries `space_id`; both REST hops name the space in the header.
      expect(transport.launches[0]!.body).not.toContain("space_id");
      expect(transport.launches[0]!.spaceHeader).toBe("spc_beta");
      expect(transport.polls).toEqual(["spc_beta"]);
    } finally {
      await built.close();
    }
  });

  it("refuses a missing or unknown space in the server's words, launching and recording nothing", async () => {
    const transport = transcript();
    const { built, tool } = await tools(transport);
    try {
      const missing = JSON.parse(
        text(await tool("run_and_wait").execute("c1", { kind: "agent", name: "demo" })),
      );
      const unknown = JSON.parse(
        text(await tool("run_and_wait").execute("c2", { kind: "agent", space_id: "spc_nope" })),
      );

      // Word for word what the MCP server answers any space-acting tool.
      const server = {
        reachable: SPACES.map((space) => ({ ...space, permissions: new Set<string>() })),
      } as unknown as OrgWideSpaces;
      expect(missing).toMatchObject(spaceArgumentRefusal(server, undefined)!);
      expect(unknown).toMatchObject(spaceArgumentRefusal(server, "spc_nope")!);
      expect(missing.code).toBe("missing_argument");
      expect(unknown.code).toBe("unknown_space");
      expect(transport.events).toEqual([]);
    } finally {
      await built.close();
    }
  });
});

describe("the conversation's forwarded tools and resources", () => {
  it("records the space a forwarded call names before dispatching it, and none when it names none", async () => {
    const transport = transcript();
    const { built, tool } = await tools(transport);
    try {
      await tool("invoke_operation").execute("c1", {
        operation_id: "listAgents",
        space_id: "spc_beta",
      });
      expect(transport.events).toEqual(["touch spc_beta", "tools/call"]);
      expect(transport.toolCalls[0]).toMatchObject({
        arguments: { operation_id: "listAgents", space_id: "spc_beta" },
      });

      transport.events.length = 0;
      await tool("invoke_operation").execute("c2", { operation_id: "listAgents" });
      expect(transport.events).toEqual(["tools/call"]);
    } finally {
      await built.close();
    }
  });

  it("records every space of the turn before a call that omits an optional space_id, and none for a required one", async () => {
    const transport = transcript();
    const { built, tool } = await tools(transport);
    try {
      await tool("search").execute("c1", { query: "x" });
      expect(transport.events.slice(0, 2).sort()).toEqual(["touch spc_alpha", "touch spc_beta"]);
      expect(transport.events[2]).toBe("tools/call");

      transport.events.length = 0;
      await tool("search").execute("c2", { query: "x", space_id: "spc_beta" });
      expect(transport.events).toEqual(["touch spc_beta", "tools/call"]);

      // An operation search reads no space's data; any other kind does.
      transport.events.length = 0;
      await tool("search").execute("c4", { kinds: ["operation"] });
      expect(transport.events).toEqual(["tools/call"]);
      // The filter alone makes it an operations search; beside `integration` it is not.
      transport.events.length = 0;
      await tool("search").execute("c6", { tag: "Agents" });
      expect(transport.events).toEqual(["tools/call"]);
      transport.events.length = 0;
      await tool("search").execute("c7", { tag: "Agents", integration: "@acme/crm" });
      expect(transport.events.slice(0, 2).sort()).toEqual(["touch spc_alpha", "touch spc_beta"]);
      for (const kinds of [["agent"], ["skill"], ["integration_tool"], ["operation", "agent"]]) {
        transport.events.length = 0;
        await tool("search").execute("c5", { kinds });
        expect(transport.events.slice(0, 2).sort()).toEqual(["touch spc_alpha", "touch spc_beta"]);
      }

      transport.events.length = 0;
      await tool("invoke_operation").execute("c3", { operation_id: "listAgents" });
      expect(transport.events).toEqual(["tools/call"]);
    } finally {
      await built.close();
    }
  });

  it("keeps the text of a skill read through `read` in the replay", async () => {
    const transport = transcript();
    const { built, tool } = await tools(transport);
    try {
      const result = (await tool("read").execute("c1", {
        uri: "skill://spc_beta/acme/tone/tone/SKILL.md",
        space_id: "spc_beta",
      })) as { content: Array<{ text?: string }>; persistedContent?: unknown };
      expect(result.content.map((block) => block.text).join("")).toContain("# Tone");
      // No receipt stands in for it: the stored content is the text itself.
      expect(result.persistedContent).toBeUndefined();
    } finally {
      await built.close();
    }
  });

  it("records the space of a resource URI it can place, before the read", async () => {
    const transport = transcript();
    const { built, tool } = await tools(transport);
    try {
      await tool("read_resource").execute("c1", {
        uri: "skill://spc_beta/acme/tone/tone/SKILL.md",
      });
      expect(transport.events).toEqual(["touch spc_beta", "resources/read"]);

      transport.events.length = 0;
      await tool("read_resource").execute("c2", { uri: "appfile://file_own00001" });
      expect(transport.events).toEqual(["lookup", "resources/read"]);
    } finally {
      await built.close();
    }
  });

  it("refuses a resource of a space outside the turn's like a call naming it: unread, unrecorded", async () => {
    const transport = transcript();
    const { built, tool } = await tools(transport);
    try {
      const refused = JSON.parse(
        text(
          await tool("read_resource").execute("c1", {
            uri: "skill://spc_nope/acme/tone/tone/SKILL.md",
          }),
        ),
      );
      expect(refused).toMatchObject({
        code: "unknown_space",
        accepted: SPACES.map((space) => space.id),
      });
      expect(transport.events).toEqual([]);
    } finally {
      await built.close();
    }
  });
});

describe("the files a call names", () => {
  it("records only the space a call names, whatever files its arguments name", async () => {
    const transport = transcript();
    const { built, tool } = await tools(transport);
    try {
      await tool("read").execute("c1", {
        uri: "appfile://file_beta0001",
        space_id: "spc_alpha",
        again: ["appfile://file_gamma001", { deep: "appfile://file_own00001" }],
      });
      await tool("run_and_wait").execute("c2", {
        kind: "agent",
        scope: "@acme",
        name: "demo",
        space_id: "spc_beta",
        input: { doc: "appfile://file_alpha001" },
      });
      expect(transport.events.slice(0, 4)).toEqual([
        "touch spc_alpha",
        "tools/call",
        "touch spc_beta",
        "launch",
      ]);
      expect(transport.events).not.toContain("touch spc_gamma");
      expect(transport.lookups).toEqual([]);
    } finally {
      await built.close();
    }
  });

  it("records the space of a file resource of the turn once it is read", async () => {
    const transport = transcript();
    const { built, tool } = await tools(transport);
    try {
      await tool("read_resource").execute("c1", { uri: "appfile://file_beta0001" });
      expect(transport.events).toEqual(["lookup", "resources/read", "touch spc_beta"]);
    } finally {
      await built.close();
    }
  });

  it("forwards its own, an outside or a missing file unrecorded, the platform's refusal as is", async () => {
    const transport = transcript();
    const { built, tool } = await tools(transport);
    try {
      await tool("read_resource").execute("c1", { uri: "appfile://file_own00001" });
      await tool("read_resource").execute("c2", { uri: "appfile://file_gamma001" });
      await expect(
        tool("read_resource").execute("c3", { uri: "appfile://file_nowhere01" }),
      ).rejects.toThrow();
      expect(transport.events).toEqual([
        "lookup",
        "resources/read",
        "lookup",
        "resources/read",
        "lookup",
        "resources/read",
      ]);
    } finally {
      await built.close();
    }
  });

  it("records nothing when the file is gone between the space lookup and the read (not_found)", async () => {
    const transport = transcript();
    const { built, tool } = await tools(transport);
    try {
      await expect(
        tool("read_resource").execute("c1", { uri: "appfile://file_beta_private" }),
      ).rejects.toThrow();
      expect(transport.events).toEqual(["lookup", "resources/read"]);
    } finally {
      await built.close();
    }
  });

  it("fails a file read whose space cannot be recorded: its content is not returned", async () => {
    const transport = transcript();
    const { built, tool } = await tools(transport, "spc_beta");
    try {
      await expect(
        tool("read_resource").execute("c1", { uri: "appfile://file_beta0001" }),
      ).rejects.toThrow("cannot record spc_beta");
      expect(transport.events).toEqual(["lookup", "resources/read"]);
    } finally {
      await built.close();
    }
  });
});
