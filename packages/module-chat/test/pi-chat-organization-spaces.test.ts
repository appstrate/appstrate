// SPDX-License-Identifier: Apache-2.0

/**
 * The tool layer of a conversation: the connection is the organization
 * endpoint, whose space-acting tools each take a `space_id` (a limited
 * conversation's spaces are its origin alone).
 *
 * The local `run_and_wait` takes the space from its arguments (refusing a missing
 * one in the server's own words), strips it before the shared launch, sends it as
 * `X-Space-Id` on the REST hops, and records it on the session first. A forwarded
 * tool and a `read_resource` record the space they name the same way.
 */

import { describe, expect, it } from "bun:test";
import type { ExtensionAPI } from "@appstrate/runner-pi";
import {
  spaceArgumentRefusal,
  type OrgWideSpaces,
} from "../../../apps/api/src/modules/mcp/spaces.ts";
import { refusalResult } from "../../../apps/api/src/modules/mcp/tool-results.ts";
import { platformMcpUrl } from "../src/platform-mcp.ts";
import { buildPlatformMcpTools, type TurnSpaces } from "../src/pi-chat/mcp-tools.ts";

/** Nothing listens here: a hop that escapes the injected fetch throws. */
const ORIGIN = "http://127.0.0.1:1";
const RUN_ID = "run_org_1";
const SPACES = [
  { id: "spc_alpha", name: "Alpha", role: "operator", permissions: ["files:read"] },
  { id: "spc_beta", name: "Beta", role: "admin", permissions: ["files:read"] },
  // Acted in, but its files are not the caller's to read.
  { id: "spc_delta", name: "Delta", role: "custom", permissions: ["chat:read"] },
];

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
              name: "read_file",
              inputSchema: {
                type: "object",
                properties: { uri: { type: "string" }, space_id: spaceId },
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
        return reply({ content: [{ type: "text", text: "{}" }] });
      }
      if (msg.method === "resources/read") {
        events.push("resources/read");
        return reply({ contents: [{ uri: "x", mimeType: "text/plain", text: "body" }] });
      }
      return reply({});
    }
    if (req.method === "POST" && url.pathname.endsWith("/run")) {
      events.push("launch");
      launches.push({ spaceHeader: req.headers.get("x-space-id"), body: await req.text() });
      return json({ id: RUN_ID, packageId: "@acme/demo", status: "pending" });
    }
    if (req.method === "GET" && url.pathname === `/api/runs/${RUN_ID}`) {
      polls.push(req.headers.get("x-space-id"));
      return json({ id: RUN_ID, packageId: "@acme/demo", status: "success" });
    }
    if (req.method === "GET" && url.pathname === "/api/files") return json({ data: [] });
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  const lookups: string[][] = [];
  return { fetch: fetchImpl, events, launches, polls, toolCalls, lookups };
}

function organizationOf({ events, lookups }: ReturnType<typeof transcript>): TurnSpaces {
  return {
    spaces: SPACES,
    touch: async (spaceId) => {
      events.push(`touch ${spaceId}`);
    },
    // A file id names its space here (`file_beta…` → `spc_beta`); `file_own…` is a file the
    // conversation holds, which names none; any other id is missing. Each lookup is kept: one
    // per call.
    fileSpaces: async (uris) => {
      lookups.push([...uris]);
      return new Map(
        uris.flatMap((uri) => {
          if (uri.startsWith("appfile://file_own")) return [[uri, null] as const];
          const space = uri.match(/^appfile:\/\/file_(alpha|beta|gamma|delta)/)?.[1];
          return space ? [[uri, `spc_${space}`] as const] : [];
        }),
      );
    },
  };
}

async function tools(transport: ReturnType<typeof transcript>) {
  const built = await buildPlatformMcpTools({
    url: platformMcpUrl(ORIGIN, "org_1"),
    headers: { authorization: "Bearer loopback", "x-org-id": "org_1" },
    organization: organizationOf(transport),
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
      expect(transport.events).toEqual(["resources/read"]);
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
  it("records the space of each file a cross-space reader names, after one lookup", async () => {
    const transport = transcript();
    const { built, tool } = await tools(transport);
    try {
      // An unlimited conversation over Alpha and Beta reads a Beta file from Alpha.
      await tool("read_file").execute("c1", {
        uri: "appfile://file_beta0001",
        space_id: "spc_alpha",
        again: ["appfile://file_beta0001", { deep: "appfile://file_own00001" }],
      });
      expect(transport.events).toEqual(["touch spc_alpha", "touch spc_beta", "tools/call"]);
      expect(transport.lookups).toEqual([["appfile://file_beta0001", "appfile://file_own00001"]]);
    } finally {
      await built.close();
    }
  });

  it("refuses, as missing and recording nothing, a file a dispatched call cannot reach in its space", async () => {
    const transport = transcript();
    const { built, tool } = await tools(transport);
    try {
      const calls = [
        // Pinned to Alpha: a Beta input would only 404 there.
        [
          "run_and_wait",
          {
            kind: "agent",
            name: "demo",
            space_id: "spc_alpha",
            input: { doc: "appfile://file_beta0002" },
          },
        ],
        [
          "invoke_operation",
          { operation_id: "x", space_id: "spc_alpha", body: { f: "appfile://file_beta0002" } },
        ],
        // Outside the turn's spaces, for any tool: no space id is named.
        ["read_file", { uri: "appfile://file_gamma001", space_id: "spc_alpha" }],
        ["read_resource", { uri: "appfile://file_gamma001" }],
      ] as const;
      for (const [name, args] of calls) {
        const text_ = text(await tool(name).execute("c1", args));
        expect(JSON.parse(text_)).toMatchObject({ code: "not_found" });
        expect(text_).not.toMatch(/spc_(beta|gamma)/);
      }
      expect(transport.events).toEqual([]);

      // Its own space's file and the conversation's own file pass, recording the named space.
      transport.events.length = 0;
      await tool("run_and_wait").execute("c2", {
        kind: "agent",
        scope: "@acme",
        name: "demo",
        space_id: "spc_alpha",
        input: { a: "appfile://file_alpha001", own: "appfile://file_own00001" },
      });
      expect(transport.events.slice(0, 2)).toEqual(["touch spc_alpha", "launch"]);
    } finally {
      await built.close();
    }
  });

  it("answers a missing file, one outside the turn and one it may not read alike, recording nothing", async () => {
    const transport = transcript();
    const { built, tool } = await tools(transport);
    try {
      const answer = async (uri: string) =>
        text(await tool("read_file").execute("c1", { uri, space_id: "spc_alpha" }));
      // The same file id in three places: nowhere, a space the turn does not act in, and a
      // turn space without `files:read`.
      const [missing, outside, unreadable] = await Promise.all(
        ["file_nowhere1", "file_gamma003", "file_delta003"].map((id) => answer(`appfile://${id}`)),
      );
      // Byte for byte what `read_file` answers for a file the platform refuses (container ACL).
      const platform = (id: string) =>
        (
          refusalResult({
            code: "not_found",
            error: `File not found: appfile://${id}`,
            arguments: ["uri"],
          }).content[0] as { text: string }
        ).text;
      expect(missing).toBe(platform("file_nowhere1"));
      expect(outside).toBe(platform("file_gamma003"));
      expect(unreadable).toBe(platform("file_delta003"));
      expect(transport.events).toEqual([]);
      expect(transport.toolCalls).toEqual([]);

      // A nested file names the argument holding it.
      const nested = JSON.parse(
        text(
          await tool("invoke_operation").execute("c2", {
            operation_id: "x",
            space_id: "spc_alpha",
            body: { files: ["appfile://file_alpha001", "appfile://file_nowhere1"] },
          }),
        ),
      );
      expect(nested.arguments).toEqual(["body.files.1"]);
    } finally {
      await built.close();
    }
  });

  it("refuses arguments nested past the bound, cleanly", async () => {
    const transport = transcript();
    const { built, tool } = await tools(transport);
    try {
      let nested: unknown = "appfile://file_beta0001";
      for (let level = 0; level < 100_000; level++) nested = [nested];
      const refused = JSON.parse(
        text(await tool("read_file").execute("c1", { uri: nested, space_id: "spc_alpha" })),
      );
      expect(refused).toMatchObject({ code: "invalid_request" });
      expect(transport.events).toEqual([]);
    } finally {
      await built.close();
    }
  });
});
